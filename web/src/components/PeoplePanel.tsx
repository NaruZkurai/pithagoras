import { useEffect, useState } from "react";
import {
  LuCircleUser,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
  LuTriangleAlert,
} from "react-icons/lu";
import { api, type Person, type Role, type ToolRule } from "../api";

const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: "primary", label: "Primary", hint: "You. Everything." },
  { id: "colleague", label: "Colleague", hint: "Reads and answers. Cannot change or run anything." },
  { id: "guest", label: "Guest", hint: "Answers what they ask, volunteers nothing." },
  { id: "unknown", label: "Blocked", hint: "Turned away before reaching the agent." },
];

/**
 * Everyone who has spoken to the agent.
 *
 * Strangers appear here having already been refused — the list is how you let
 * somebody in, not a log of who got through.
 */
export function PeoplePanel({ onError }: { onError: (e: string) => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setPeople((await api.people()).people);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-subtle">
        <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading…
      </p>
    );
  }

  const waiting = people.filter((p) => p.role === "unknown");

  return (
    <>
      {waiting.length > 0 && (
        <section className="mb-5 rounded-xl border border-warn/30 bg-warn/10 p-3">
          <div className="flex items-start gap-2">
            <LuTriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <p className="text-xs text-fg-muted">
              {waiting.length === 1 ? "Someone has" : `${waiting.length} people have`} messaged the
              agent and been turned away. Give them a role to let them through.
            </p>
          </div>
        </section>
      )}

      <p className="mb-4 text-xs text-fg-faint">
        The agent only talks to people listed here. Identities come from the platform's own id, so
        renaming themselves changes nothing. A colleague's session never loads your PrimaryUser.md
        or MEMORY.md.
      </p>

      {people.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-fg-faint">
          Nobody yet. People appear here the first time they message a channel.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {people.map((p) => (
            <li key={p.key} className="rounded-xl border border-line bg-raised/40 p-3">
              <div className="flex items-center gap-2">
                <LuCircleUser className="h-4 w-4 shrink-0 text-fg-faint" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg">{p.name}</p>
                  <p className="truncate font-mono text-[11px] text-fg-faint">{p.key}</p>
                </div>
                <select
                  value={p.role}
                  onChange={(e) => act(() => api.setPersonRole(p.key, e.target.value as Role))}
                  className="shrink-0 rounded-lg border border-line bg-raised/60 px-2 py-1.5 text-xs outline-none focus:border-accent/60"
                >
                  {ROLES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => act(() => api.forgetPerson(p.key))}
                  title="Forget — the next message makes them a stranger again"
                  className="shrink-0 rounded-lg p-1.5 text-fg-faint transition hover:bg-danger/10 hover:text-danger"
                >
                  <LuTrash2 className="h-4 w-4" />
                </button>
              </div>
              <input
                defaultValue={p.notes}
                placeholder="What the agent should know about them — role, what they work on"
                onBlur={(e) =>
                  e.target.value !== p.notes && act(() => api.setPersonNotes(p.key, e.target.value))
                }
                className="mt-2 w-full rounded-lg border border-line bg-raised/60 px-2.5 py-1.5 text-xs outline-none placeholder:text-fg-faint focus:border-accent/60"
              />
            </li>
          ))}
        </ul>
      )}

      <ToolRules onError={onError} />
    </>
  );
}

/**
 * Exceptions to the read-only default.
 *
 * Without these the only settings are "reads files" and "trusted like you", and
 * the useful middle has nowhere to live: a colleague who may list your inbox and
 * do nothing else needs one command, not a shell.
 */
function ToolRules({ onError }: { onError: (e: string) => void }) {
  const [rules, setRules] = useState<ToolRule[]>([]);
  const [role, setRole] = useState("colleague");
  const [tool, setTool] = useState("bash");
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .toolRules()
      .then((r) => setRules(r.rules))
      .catch((e) => onError((e as Error).message));

  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    setBusy(true);
    try {
      setRules((await api.addToolRule({ role, tool, pattern })).rules);
      setPattern("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-8">
      <h3 className="text-sm font-medium text-fg">Allowed anyway</h3>
      <p className="mb-3 mt-1 text-xs text-fg-faint">
        Colleagues and guests can read files and nothing else. A rule here lets one specific thing
        through — <span className="font-mono">*</span> stands for the parts that vary. A shell rule
        only ever matches a single command: anything with a pipe, a semicolon or a redirect is
        refused however well it matches, or the pattern would just be a prefix to bolt onto.
        Choosing <em>Always allow</em> on a request writes a rule here for that person alone;
        deleting it takes the permission back.
      </p>

      {rules.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {rules.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-2 rounded-xl border border-line bg-raised/40 px-3 py-2"
            >
              <span className="shrink-0 rounded bg-fg/5 px-1.5 py-0.5 text-[11px] text-fg-muted">
                {r.person_name ?? `all ${r.role}s`}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
                {r.tool}: {r.pattern}
              </span>
              <button
                onClick={async () => {
                  try {
                    setRules((await api.deleteToolRule(r.id)).rules);
                  } catch (e) {
                    onError((e as Error).message);
                  }
                }}
                className="shrink-0 rounded-lg p-1.5 text-fg-faint transition hover:bg-danger/10 hover:text-danger"
              >
                <LuTrash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-lg border border-line bg-raised/60 px-2 py-2 text-xs outline-none focus:border-accent/60"
        >
          <option value="colleague">Colleagues</option>
          <option value="guest">Guests</option>
          <option value="all">Both</option>
        </select>
        <input
          value={tool}
          onChange={(e) => setTool(e.target.value)}
          placeholder="bash"
          className="w-24 rounded-lg border border-line bg-raised/60 px-2 py-2 font-mono text-xs outline-none focus:border-accent/60"
        />
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="himalaya envelope list*"
          className="min-w-[12rem] flex-1 rounded-lg border border-line bg-raised/60 px-2 py-2 font-mono text-xs outline-none placeholder:text-fg-faint focus:border-accent/60"
        />
        <button
          onClick={add}
          disabled={busy || !pattern.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-2 text-xs text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
        >
          <LuPlus className="h-3.5 w-3.5" /> Allow
        </button>
      </div>
    </section>
  );
}
