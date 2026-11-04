"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCopy } from "@/lib/copy-client";

/**
 * Choose a new password, after a reset link has signed you in.
 *
 * The link (via /auth/confirm) has already proved the email; this only sets
 * the password on the session it created, then goes on to the workspace.
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const t = useCopy();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError(t("copy.auth.reset.error_short"));
    if (password !== confirm) return setError(t("copy.auth.reset.error_mismatch"));
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message.includes("session") ? t("copy.auth.reset.error_expired") : updateError.message);
      setBusy(false);
      return;
    }
    const me = await fetch("/api/auth/me", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    router.replace(me?.user?.tenant?.slug ? `/${me.user.tenant.slug}` : "/login");
  }

  return (
    <main style={{ maxWidth: 420, margin: "48px auto", padding: 24 }}>
      <div className="page-head"><h1>{t("copy.auth.reset.title")}</h1></div>
      <form onSubmit={submit}>
        {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="pw">{t("copy.auth.reset.password_label")}</label>
          <input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="pw2">{t("copy.auth.reset.confirm_label")}</label>
          <input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <button type="submit" disabled={busy} className="primary">{busy ? t("copy.auth.reset.submitting") : t("copy.auth.reset.submit")}</button>
      </form>
    </main>
  );
}
