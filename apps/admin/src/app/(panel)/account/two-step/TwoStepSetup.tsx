"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export function TwoStepSetup() {
  const router = useRouter();
  const [secret, setSecret] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setSecret(await api("/api/account/two-step/start"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/account/two-step/confirm", { code });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (!secret) {
    return (
      <>
        <div className="card-title">Set up an authenticator app</div>
        <div className="hint">
          Use Google Authenticator, 1Password, Authy or any app that shows six digit codes. You will add a key to it,
          then type the code it shows.
        </div>
        {error && <div className="error-text">{error}</div>}
        <div><button className="btn btn-primary" onClick={start} disabled={busy}>Start</button></div>
      </>
    );
  }

  return (
    <form onSubmit={confirm} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card-title">1. Add this key to your app</div>
      <div className="hint">Choose “Enter a setup key”, name it Pratibha Admin, and type this key (time based):</div>
      <div className="secret-box">{secret.secret}</div>
      <div className="hint">
        On a phone with the app installed you can <a href={secret.uri}>open the key directly</a>.
      </div>
      <div className="card-title" style={{ marginTop: 6 }}>2. Type the code the app shows</div>
      <input className="input center" inputMode="numeric" autoComplete="one-time-code" maxLength={7}
        aria-label="Six digit code" value={code} onChange={(e) => setCode(e.target.value)} required
        style={{ fontSize: 18, letterSpacing: "0.2em", maxWidth: 220 }} />
      {error && <div className="error-text" role="alert">{error}</div>}
      <div><button className="btn btn-primary" type="submit" disabled={busy}>Turn on</button></div>
    </form>
  );
}
