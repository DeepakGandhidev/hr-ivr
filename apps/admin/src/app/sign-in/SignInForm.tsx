"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { next } = await api<{ next: string }>("/api/auth/sign-in", { email, password });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="field">
        <label className="label" htmlFor="email">Email</label>
        <input id="email" className="input" type="email" autoComplete="username" value={email}
          onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </div>
      <div className="field">
        <label className="label" htmlFor="password">Password</label>
        <input id="password" className="input" type="password" autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} required />
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
    </form>
  );
}
