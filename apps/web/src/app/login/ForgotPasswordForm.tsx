"use client";

import { useState } from "react";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import { useCopy } from "@/lib/copy-client";

/**
 * "Forgot password?" (/forgot-password). The reset link comes from Pratibha's
 * mailbox and opens /reset-password signed in. The confirmation reads the
 * same whether or not the address has an account, so this screen cannot be
 * used to find out who does.
 */
export default function ForgotPasswordForm() {
  const t = useCopy();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || t("copy.auth.forgot.error_failed"));
        return;
      }
      setSentTo(email);
    } catch {
      setError(t("copy.auth.forgot.error_failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-wrap">
      {/* No sidebar on the auth screens, so the toggle floats. */}
      <ThemeToggle floating />
      <div className="auth-card">
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 22 }}>
          <span className="brand-mark">P</span>
          <strong style={{ fontSize: 15 }}>Pratibha</strong>
        </div>

        <h1 style={{ fontSize: 21 }}>{t("copy.auth.forgot.title")}</h1>
        <p className="muted" style={{ marginBottom: 22 }}>
          {t("copy.auth.forgot.subtitle")}
        </p>

        {sentTo ? (
          <div className="notice notice-success">{t("copy.auth.forgot.sent", { email: sentTo })}</div>
        ) : (
          <form onSubmit={handleSubmit} className="stack">
            {error && <div className="notice notice-error">{error}</div>}

            <div>
              <label htmlFor="email">{t("copy.auth.forgot.email_label")}</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                required
              />
            </div>

            <button type="submit" className="primary" disabled={loading} style={{ width: "100%" }}>
              {loading ? t("copy.auth.forgot.submitting") : t("copy.auth.forgot.submit")}
            </button>
          </form>
        )}

        <p className="muted" style={{ marginTop: 20, textAlign: "center", fontSize: 13 }}>
          <Link href="/login">{t("copy.auth.forgot.back_link")}</Link>
        </p>
      </div>
    </main>
  );
}
