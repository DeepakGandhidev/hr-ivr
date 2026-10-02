"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { next } = await api<{ next: string }>("/api/auth/accept-invite", { token, password });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <input type="email" value={email} autoComplete="username" readOnly hidden />
      <div className="field">
        <label className="label" htmlFor="pw">Password</label>
        <input id="pw" className="input" type="password" autoComplete="new-password" value={password}
          onChange={(e) => setPassword(e.target.value)} required minLength={12} />
      </div>
      <div className="field">
        <label className="label" htmlFor="pw2">Password again</label>
        <input id="pw2" className="input" type="password" autoComplete="new-password" value={confirm}
          onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Set password"}</button>
    </form>
  );
}
