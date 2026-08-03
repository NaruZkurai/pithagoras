import { useEffect, useState } from "react";
import {
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuCircleUser,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
  LuTriangleAlert,
} from "react-icons/lu";
import { api, type Person, type Role, type ToolRule } from "../api";

const inputCls =
  "w-full rounded-lg border border-line bg-raised/60 px-3 py-2 text-sm outline-none transition placeholder:text-fg-faint focus:border-accent/60";
const btnCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-fg/5 px-3 py-2 text-sm text-fg transition hover:bg-fg/10 disabled:opacity-40";
const primaryCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-2 text-sm text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40";

const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: "primary", label: "Primary", hint: "You. Everything." },
  {
    id: "colleague",
    label: "Colleague",
    hint: "Reads, searches, explains. Anything else needs your say-so.",
  },
  { id: "guest", label: "Guest", hint: "Answers what they ask and volunteers nothing." },
  { id: "unknown", label: "Blocked", hint: "Turned away before reaching the agent." },
];

const ROLE_STYLE: Record<string, string> = {
  primary: "text-accent",
  colleague: "text-fg-muted",
  guest: "text-fg-subtle",
  unknown: "text-warn",
};

/**
 * Everyone who has spoken to the agent.
 *
 * A list of names, and a page each. The roster is read far more often than it
 * is changed — usually to see whether somebody got through — so the settings
 * live one click in rather than in every row.
 *
 * Strangers appear here having already been refused: the list is how you let
 * somebody in, not a log of who got through.
 */
export function PeoplePanel({ onError }: { onError: (e: string) => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [rules, setRules] = useState<ToolRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const load = async () => {
    try {
      const [p, r] = await Promise.all([api.people(), api.toolRules()]);
      setPeople(p.people);
      setRules(r.rules);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-subtle">
        <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading…
      </p>
    );
  }

  const open = people.find((p) => p.key === openKey);
  if (open) {
    return (
      <PersonDetail
        person={open}
        rules={rules.filter((r) => r.person_key === open.key)}
        onBack={() => setOpenKey(null)}
        onChanged={load}
        onError={onError}
      />
    );
  }

  const waiting = people.filter((p) => p.role === "unknown");
  const roleWide = rules.filter((r) => !r.person_key);

  return (
    <>
      {waiting.length > 0 && (
        <section className="mb-4 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3">
          <LuTriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <p className="text-xs text-fg-muted">
            {waiting.length === 1 ? "Someone has" : `${waiting.length} people have`} messaged the
            agent and been turned away. Open them to let them through.
          </p>
        </section>
      )}

      <p className="mb-3 text-xs text-fg-faint">
        The agent only talks to people listed here. Identities come from the platform's own id, so
        renaming themselves changes nothing.
      </p>

      {people.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-fg-faint">
          Nobody yet. People appear here the first time they message a channel.
        </p>
      ) : (
        <ul className="space-y-1">
          {people.map((p) => (
            <li key={p.key}>
              <button
                onClick={() => setOpenKey(p.key)}
                className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-raised/40 px-3 py-2 text-left transition hover:bg-fg/5"
              >
                <LuCircleUser className="h-4 w-4 shrink-0 text-fg-faint" />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{p.name}</span>
                <span className={`shrink-0 text-xs ${ROLE_STYLE[p.role] ?? "text-fg-subtle"}`}>
                  {ROLES.find((r) => r.id === p.role)?.label ?? p.role}
                </span>
                <LuChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {roleWide.length > 0 && (
        <section className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Allowed for a whole role
          </h3>
          <ul className="mt-2 space-y-1">
            {roleWide.map((r) => (
              <RuleRow
                key={r.id}
                rule={r}
                scope={`all ${r.role}s`}
                onDelete={async () => {
                  try {
                    setRules((await api.deleteToolRule(r.id)).rules);
                  } catch (e) {
                    onError((e as Error).message);
                  }
                }}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function RuleRow({
  rule,
  scope,
  onDelete,
}: {
  rule: ToolRule;
  scope?: string;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-xl border border-line bg-raised/40 px-3 py-2">
      {scope && (
        <span className="shrink-0 rounded bg-fg/5 px-1.5 py-0.5 text-[11px] text-fg-muted">
          {scope}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
        {rule.tool}: {rule.pattern}
      </span>
      <button
        onClick={onDelete}
        title="Revoke"
        className="shrink-0 rounded-lg p-1.5 text-fg-faint transition hover:bg-danger/10 hover:text-danger"
      >
        <LuTrash2 className="h-4 w-4" />
      </button>
    </li>
  );
}

function PersonDetail({
  person,
  rules,
  onBack,
  onChanged,
  onError,
}: {
  person: Person;
  rules: ToolRule[];
  onBack: () => void;
  onChanged: () => Promise<void>;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState(person.name);
  const [role, setRole] = useState<Role>(person.role);
  const [notes, setNotes] = useState(person.notes);
  const [tool, setTool] = useState("bash");
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(person.name);
    setRole(person.role);
    setNotes(person.notes);
  }, [person.key]);

  const dirty = name !== person.name || role !== person.role || notes !== person.notes;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-fg-subtle transition hover:text-fg-muted"
      >
        <LuChevronLeft className="h-3.5 w-3.5" /> People
      </button>

      <div className="mb-5 flex items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-fg/5 text-fg-subtle">
          <LuCircleUser className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm text-fg">{person.name}</p>
          <p className="truncate font-mono text-[11px] text-fg-faint">{person.key}</p>
        </div>
      </div>

      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs text-fg-subtle">Name</span>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <div>
          <span className="mb-1.5 block text-xs text-fg-subtle">Role</span>
          <div className="space-y-1">
            {ROLES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRole(r.id)}
                className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition ${
                  role === r.id
                    ? "border-accent/40 bg-accent/10"
                    : "border-line bg-raised/40 hover:bg-fg/5"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm ${role === r.id ? "text-accent" : "text-fg"}`}>
                    {r.label}
                  </span>
                  <span className="block text-[11px] text-fg-faint">{r.hint}</span>
                </span>
                {role === r.id && <LuCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-fg-subtle">What the agent should know</span>
          <textarea
            className={inputCls}
            rows={3}
            value={notes}
            placeholder="Their role, what they work on — the agent is told this every time they write."
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        <div className="flex gap-2">
          <button
            className={primaryCls}
            disabled={busy || !dirty}
            onClick={() =>
              act(async () => {
                await api.updatePerson(person.key, { name, role, notes });
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
              })
            }
          >
            {busy ? (
              <LuRefreshCw className="h-4 w-4 animate-spin" />
            ) : saved ? (
              <LuCheck className="h-4 w-4" />
            ) : null}
            {saved ? "Saved" : "Save"}
          </button>
          <button
            className={btnCls}
            disabled={busy}
            title="The next message from them arrives as a stranger again"
            onClick={() =>
              act(async () => {
                await api.forgetPerson(person.key);
                onBack();
              })
            }
          >
            <LuTrash2 className="h-4 w-4" /> Forget
          </button>
        </div>
      </div>

      <section className="mt-8">
        <h3 className="text-sm font-medium text-fg">Allowed anyway</h3>
        <p className="mb-3 mt-1 text-xs text-fg-faint">
          What {person.name} may do despite their role. Choosing <em>Always allow</em> on one of
          their requests writes a rule here, and deleting it takes the permission back.{" "}
          <span className="font-mono">*</span> stands for the parts that vary. A shell rule matches
          a single command only — anything carrying a pipe, a semicolon or a redirect is refused
          however well it matches.
        </p>

        {rules.length > 0 ? (
          <ul className="mb-3 space-y-1">
            {rules.map((r) => (
              <RuleRow key={r.id} rule={r} onDelete={() => act(() => api.deleteToolRule(r.id))} />
            ))}
          </ul>
        ) : (
          <p className="mb-3 rounded-xl border border-dashed border-line px-3 py-4 text-center text-xs text-fg-faint">
            Nothing yet — they can read, and anything else needs asking.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
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
            disabled={busy || !pattern.trim()}
            onClick={() =>
              act(async () => {
                await api.addToolRule({
                  role: person.role,
                  tool,
                  pattern,
                  personKey: person.key,
                });
                setPattern("");
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-2 text-xs text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
          >
            <LuPlus className="h-3.5 w-3.5" /> Allow
          </button>
        </div>
      </section>
    </>
  );
}
