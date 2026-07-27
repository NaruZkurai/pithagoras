import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { PiClient, PiCommand, PiState, PiStats } from "./types.js";

/** Read a member that may be a getter or a method, without assuming which. */
function callable(obj: any, key: string): any {
  const v = obj?.[key];
  return typeof v === "function" ? v.call(obj) : v;
}

/**
 * pi driven through its SDK, in this process.
 *
 * Preferred over the RPC subprocess for host sessions: pi's own docs recommend
 * it for Node, the config surface is typed instead of stringly-typed commands,
 * and — the reason this migration happened — `session.prompt()` runs registered
 * slash commands, which RPC accepted and then silently dropped.
 *
 * The trade is isolation: a crash here takes the portal with it, where a
 * subprocess crash only took its own session. Container sessions keep using RPC
 * and are unaffected.
 */
export class SdkPiClient extends EventEmitter implements PiClient {
  private disposed = false;
  /** Dialogs an extension is waiting on, keyed by request id. */
  private pendingUi = new Map<string, (r: { cancelled?: boolean; value?: unknown }) => void>();

  private constructor(
    private readonly session: any,
    private readonly modelRuntime: any,
    private readonly unsubscribe: () => void
  ) {
    super();
    this.setMaxListeners(0);
  }

  static async create(opts: {
    cwd: string;
    sessionDir: string;
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
  }): Promise<SdkPiClient> {
    // Imported lazily so the server still boots (and the container executor
    // still works) if the SDK cannot initialise in this environment.
    const pi: any = await import("@earendil-works/pi-coding-agent");

    const modelRuntime = await pi.ModelRuntime.create();

    // Without an explicit loader the SDK starts with no extensions, skills or
    // prompt templates — so installed packages contribute no commands at all.
    // The CLI wires this up for you; here it has to be asked for.
    let resourceLoader: any;
    try {
      // Both are required: the constructor resolves each and throws on
      // undefined, which previously left every session with no extensions.
      resourceLoader = new pi.DefaultResourceLoader({
        cwd: opts.cwd,
        agentDir: pi.getAgentDir(),
      });
      await resourceLoader.reload();
    } catch (e) {
      console.error(`[portal] resource loader unavailable: ${(e as Error).message}`);
      resourceLoader = undefined;
    }

    let model;
    if (opts.provider && opts.modelId) {
      model = modelRuntime.getModel(opts.provider, opts.modelId);
      if (!model) {
        // Fall through to pi's own resolution rather than refusing to start.
        console.error(
          `[portal] model ${opts.provider}/${opts.modelId} not found; using pi's default`
        );
      }
    }

    const { session } = await pi.createAgentSession({
      cwd: opts.cwd,
      sessionManager: pi.SessionManager.create(opts.sessionDir),
      modelRuntime,
      ...(resourceLoader ? { resourceLoader } : {}),
      ...(model ? { model } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    });

    const client = new SdkPiClient(session, modelRuntime, () => {});
    const unsub = session.subscribe((event: any) => client.emit("event", event));
    // Replace the placeholder now that we have the real unsubscribe.
    (client as any).unsubscribe = typeof unsub === "function" ? unsub : () => {};

    // Extensions are loaded by the resource loader but stay inert until they
    // are bound. Every pi mode does this; the SDK leaves it to the host, which
    // is why commands were missing and hasExtensionHandlers was false.
    //
    // Binding a uiContext is what makes interactive commands work at all: an
    // unbound host makes ctx.ui.select() return a default immediately, so a
    // command that asks the user something silently does nothing.
    try {
      await session.bindExtensions({
        uiContext: client.buildUiContext(),
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          reload: async () => {
            await session.reload();
          },
        },
        onError: (err: any) =>
          client.emit("event", {
            type: "extension_error",
            extensionPath: err?.extensionPath,
            error: String(err?.error ?? err),
          }),
      });
    } catch (e) {
      console.error(`[portal] binding extensions failed: ${(e as Error).message}`);
    }

    return client;
  }

  get running(): boolean {
    return !this.disposed;
  }

  /**
   * Bridges pi's extension dialogs to the browser: each call emits a request
   * event and parks a promise until the UI answers, mirroring what the TUI does
   * by drawing a menu.
   */
  private buildUiContext() {
    const ask = (payload: Record<string, unknown>, opts: any, fallback: unknown) =>
      new Promise((resolve) => {
        const id = randomUUID();
        let settled = false;
        const finish = (value: unknown) => {
          if (settled) return;
          settled = true;
          this.pendingUi.delete(id);
          resolve(value);
        };
        this.pendingUi.set(id, (r) => finish(r.cancelled ? fallback : r.value));

        // Never park forever — an unanswered dialog would wedge the session.
        const ms = typeof opts?.timeout === "number" ? opts.timeout : 300_000;
        const timer = setTimeout(() => {
          this.emit("event", { type: "extension_ui_cancel", id });
          finish(fallback);
        }, ms);
        if (typeof timer.unref === "function") timer.unref();
        opts?.signal?.addEventListener?.("abort", () => finish(fallback));

        this.emit("event", { type: "extension_ui_request", id, ...payload });
      });

    const fireAndForget = (payload: Record<string, unknown>) =>
      this.emit("event", { type: "extension_ui_request", id: randomUUID(), ...payload });

    return {
      select: (title: string, options: string[], opts?: any) =>
        ask({ method: "select", title, options }, opts, undefined),
      confirm: (title: string, message: string, opts?: any) =>
        ask({ method: "confirm", title, message }, opts, false),
      input: (title: string, placeholder: string, opts?: any) =>
        ask({ method: "input", title, placeholder }, opts, undefined),
      editor: (title: string, content: string, opts?: any) =>
        ask({ method: "editor", title, defaultValue: content }, opts, undefined),
      notify: (message: string, type?: string) =>
        fireAndForget({ method: "notify", message, notifyType: type }),
      setStatus: (key: string, text: string) =>
        fireAndForget({ method: "setStatus", statusKey: key, statusText: text }),
      setWidget: (key: string, content: unknown) => {
        if (content === undefined || Array.isArray(content)) {
          fireAndForget({ method: "setWidget", widgetKey: key, widgetContent: content });
        }
      },
      onTerminalInput: () => () => {},
      // TUI-only affordances with no meaning in a browser.
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
    };
  }

  /** Answer a dialog the UI just resolved. */
  respondUi(id: string, response: { cancelled?: boolean; value?: unknown }): boolean {
    const pending = this.pendingUi.get(id);
    if (!pending) return false;
    pending(response);
    return true;
  }

  async prompt(message: string): Promise<void> {
    // expandPromptTemplates lets "/name" resolve to its template or extension
    // command, which is how the TUI treats the same input.
    await this.session.prompt(message, { expandPromptTemplates: true });
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.unsubscribe();
    } catch {
      // best effort
    }
    try {
      this.session.dispose?.();
    } catch {
      // best effort
    }
    this.emit("exit", { code: 0, signal: null });
  }

  async getState(): Promise<PiState> {
    const model = this.session.model;
    return {
      model: {
        id: model?.id ?? "unknown",
        name: model?.name ?? "unknown",
        provider: model?.provider ?? "unknown",
        contextWindow: model?.contextWindow,
      },
      thinkingLevel: this.session.thinkingLevel ?? "medium",
      autoCompactionEnabled: callable(this.session, "autoCompactionEnabled") ?? true,
      messageCount: callable(this.session, "messages")?.length,
    };
  }

  async getStats(): Promise<PiStats> {
    const stats = (await this.session.getSessionStats?.()) ?? {};
    const usage = (await this.session.getContextUsage?.()) ?? {};
    const contextWindow = usage.contextWindow ?? this.session.model?.contextWindow ?? 0;
    const used = usage.tokens ?? 0;
    return {
      tokens: stats.tokens ?? { input: 0, output: 0, total: 0 },
      cost: stats.cost ?? 0,
      contextUsage: {
        tokens: used,
        contextWindow,
        percent: usage.percent ?? (contextWindow ? (used / contextWindow) * 100 : 0),
      },
      toolCalls: stats.toolCalls ?? 0,
      totalMessages: stats.totalMessages ?? 0,
    };
  }

  async getThinkingLevels(): Promise<string[]> {
    const levels = callable(this.session, "getAvailableThinkingLevels");
    return Array.isArray(levels) && levels.length
      ? levels
      : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  }

  /** Only models with working auth, unlike RPC which listed the whole catalogue. */
  async getModels(): Promise<PiState["model"][]> {
    const available = (await this.modelRuntime.getAvailable?.()) ?? [];
    return available.map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: m.provider,
      contextWindow: m.contextWindow,
    }));
  }

  async getCommands(): Promise<PiCommand[]> {
    // promptTemplates is a getter in some builds and a method in others;
    // optional-call would throw on the non-callable form, so check first.
    const raw = this.session.promptTemplates;
    const templates = typeof raw === "function" ? raw.call(this.session) : raw;
    const list = Array.isArray(templates) ? templates : (templates?.prompts ?? []);
    return list.map((t: any) => ({
      name: t.name,
      description: t.description,
      source: t.source ?? "prompt",
    }));
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await this.session.setModel(model);
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.session.setThinkingLevel(level);
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.session.setAutoCompactionEnabled(enabled);
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    this.session.setAutoRetryEnabled(enabled);
  }

  async compact(): Promise<void> {
    await this.session.compact();
  }
}
