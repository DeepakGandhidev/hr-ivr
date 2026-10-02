"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export function CodeForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { next } = await api<{ next: string }>("/api/auth/code", { code });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <input className="input center" inputMode="numeric" autoComplete="one-time-code" maxLength={7}
        aria-label="Six digit code" placeholder="123 456" value={code} onChange={(e) => setCode(e.target.value)}
        autoFocus required style={{ fontSize: 20, letterSpacing: "0.2em" }} />
      {error && <div className="error-text" role="alert">{error}</div>}
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
      <a className="back" href="/sign-in">Use a different account</a>
    </form>
  );
}
