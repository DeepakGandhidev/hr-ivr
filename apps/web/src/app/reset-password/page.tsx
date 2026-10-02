"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Choose a new password, after a reset link has signed you in.
 *
 * The link (via /auth/confirm) has already proved the email; this only sets
 * the password on the session it created, then goes on to the workspace.
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError("Use at least eight characters.");
    if (password !== confirm) return setError("The two passwords do not match.");
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message.includes("session") ? "This link has expired. Ask for a new one." : updateError.message);
      setBusy(false);
      return;
    }
    const me = await fetch("/api/auth/me", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    router.replace(me?.user?.tenant?.slug ? `/${me.user.tenant.slug}` : "/login");
  }

  return (
    <main style={{ maxWidth: 420, margin: "48px auto", padding: 24 }}>
      <div className="page-head"><h1>Choose a new password</h1></div>
      <form onSubmit={submit}>
        {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="pw">New password</label>
          <input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="pw2">New password again</label>
          <input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <button type="submit" disabled={busy} className="primary">{busy ? "Saving..." : "Save password"}</button>
      </form>
    </main>
  );
}
