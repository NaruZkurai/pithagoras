import { useState } from "react";
import { api } from "../api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center">
      <form onSubmit={submit} className="w-72 space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h1 className="text-sm font-bold tracking-wide text-cyan-300">pi portal</h1>
        <input
          autoFocus
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-cyan-600"
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-cyan-900/60 px-3 py-2 text-sm text-cyan-200 hover:bg-cyan-900 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
