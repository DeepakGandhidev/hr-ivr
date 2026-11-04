"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import ThemeToggle from "@/components/ThemeToggle";
import { useCopy } from "@/lib/copy-client";

export default function LoginPage() {
  const router = useRouter();
  const t = useCopy();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // /auth/confirm sends a link it could not use back here (?link=expired|invalid).
  useEffect(() => {
    const link = new URLSearchParams(window.location.search).get("link");
    if (link === "expired" || link === "invalid") setError(t("copy.auth.login.error_link"));
  }, [t]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      // Supabase returns "Invalid login credentials" for both a wrong password
      // and an unknown email, which is the correct behaviour: distinguishing
      // them would let anyone test which addresses have accounts.
      setError(signInError.message);
      setLoading(false);
      return;
    }

    // Ask the backend which tenant this user belongs to. /api/auth/me returns
    // the tenant nested under the user; reading a top-level `tenantSlug` that
    // the API never sends meant every account fell through to the Supabase
    // metadata fallback and, without it, was told it had no tenant.
    const meRes = await fetch("/api/auth/me", { cache: "no-store" });
    const meData = await meRes.json().catch(() => ({}));
    const tenantSlug = meData.user?.tenant?.slug ?? data.user?.user_metadata?.tenant_slug;

    if (tenantSlug) {
      router.push(`/${tenantSlug}`);
    } else if (meRes.status === 404) {
      // This used to tell the user to run "npm run db:mock:auth" — a developer
      // instruction, referring to seed data that no longer exists, shown to
      // whoever hit the problem.
      setError(t("copy.auth.login.error_no_workspace"));
    } else {
      setError(t("copy.auth.login.error_workspace_lookup"));
    }
    setLoading(false);
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

        <h1 style={{ fontSize: 21 }}>{t("copy.auth.login.title")}</h1>
        <p className="muted" style={{ marginBottom: 22 }}>
          {t("copy.auth.login.subtitle")}
        </p>

        <form onSubmit={handleSubmit} className="stack">
          {error && <div className="notice notice-error">{error}</div>}

          <div>
            <label htmlFor="email">{t("copy.auth.login.email_label")}</label>
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

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <label htmlFor="password">{t("copy.auth.login.password_label")}</label>
              <Link href="/forgot-password" style={{ fontSize: 13 }}>{t("copy.auth.login.forgot_link")}</Link>
            </div>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          <button type="submit" className="primary" disabled={loading} style={{ width: "100%" }}>
            {loading ? t("copy.auth.login.submitting") : t("copy.auth.login.submit")}
          </button>
        </form>

        <p className="muted" style={{ marginTop: 20, textAlign: "center", fontSize: 13 }}>
          {t("copy.auth.login.no_account")} <Link href="/signup">{t("copy.auth.login.signup_link")}</Link>
        </p>
      </div>
    </main>
  );
}
