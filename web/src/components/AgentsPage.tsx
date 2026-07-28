import { LuBot } from "react-icons/lu";

/**
 * Placeholder. The rail entry and route exist so the sidebar structure is
 * complete; what this section actually does is still to be decided, and
 * inventing behaviour here would only have to be undone.
 */
export function AgentsPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-cyan-500/10 text-cyan-300">
        <LuBot className="h-6 w-6" />
      </div>
      <h2 className="text-sm font-semibold text-zinc-200">Agents</h2>
      <p className="max-w-sm text-sm text-zinc-500">
        Nothing here yet — the section is wired up and waiting on what it should do.
      </p>
    </div>
  );
}
