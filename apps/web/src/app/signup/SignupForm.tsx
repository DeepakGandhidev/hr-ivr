"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import { useCopy } from "@/lib/copy-client";

/** Mirrors the slug rules the API enforces, so the field cannot produce one it rejects. */
function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export default function SignupForm({ passwordMinLength }: { passwordMinLength: number }) {
  const router = useRouter();
  const t = useCopy();
  const [companyName, setCompanyName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Set once the workspace exists but its owner still has to confirm the address.
  const [confirmation, setConfirmation] = useState<"sent" | "failed" | null>(null);
  const [resend, setResend] = useState<"idle" | "busy" | "done">("idle");

  // The slug follows the company name until someone edits it themselves —
  // asking a new user to invent a URL slug from nothing is a needless step.
  const effectiveSlug = slugTouched ? slug : slugify(companyName);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < passwordMinLength) {
      setError(t("copy.auth.signup.error_password_short", { min: passwordMinLength }));
      return;
    }
    if (!effectiveSlug) {
      setError(t("copy.auth.signup.error_workspace_name"));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: companyName,
          slug: effectiveSlug,
          ownerEmail,
          password,
          ownerName: ownerEmail.split("@")[0],
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || t("copy.auth.signup.error_failed"));
        return;
      }

      // The address still has to be confirmed: the emailed link signs them in
      // and lands on the workspace, so there is nowhere to send them yet.
      if (data.confirmation === "sent" || data.confirmation === "failed") {
        setConfirmation(data.confirmation);
        return;
      }

      // Land on the overview, which carries the setup checklist for a brand-new
      // workspace, rather than dropping the user straight into a settings form.
      const tenantSlug = data.tenant?.slug ?? effectiveSlug;
      router.push(`/${tenantSlug}`);
    } finally {
      setLoading(false);
    }
  }

  async function resendLink() {
    setResend("busy");
    try {
      await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ownerEmail }),
      });
    } finally {
      setResend("done");
    }
  }

  if (confirmation) {
    return (
      <main className="auth-wrap">
        <ThemeToggle floating />
        <div className="auth-card">
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 22 }}>
            <span className="brand-mark">P</span>
            <strong style={{ fontSize: 15 }}>Pratibha</strong>
          </div>

          <h1 style={{ fontSize: 21 }}>{t("copy.auth.signup.check_title")}</h1>
          <div className="stack" style={{ marginTop: 14 }}>
            {confirmation === "sent" ? (
              <div className="notice notice-success">{t("copy.auth.signup.check_body", { email: ownerEmail })}</div>
            ) : (
              <div className="notice notice-error">{t("copy.auth.signup.check_failed", { email: ownerEmail })}</div>
            )}
            {resend === "done" && <div className="notice notice-info">{t("copy.auth.signup.resent")}</div>}
            <button type="button" onClick={resendLink} disabled={resend === "busy"} style={{ width: "100%" }}>
              {resend === "busy" ? t("copy.auth.signup.resending") : t("copy.auth.signup.resend")}
            </button>
          </div>

          <p className="muted" style={{ marginTop: 20, textAlign: "center", fontSize: 13 }}>
            {t("copy.auth.signup.have_account")} <Link href="/login">{t("copy.auth.signup.login_link")}</Link>
          </p>
        </div>
      </main>
    );
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

        <h1 style={{ fontSize: 21 }}>{t("copy.auth.signup.title")}</h1>
        <p className="muted" style={{ marginBottom: 22 }}>
          {t("copy.auth.signup.subtitle")}
        </p>

        <form onSubmit={handleSubmit} className="stack">
          {error && <div className="notice notice-error">{error}</div>}

          <div>
            <label htmlFor="company">{t("copy.auth.signup.company_label")}</label>
            <input
              id="company"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Acme Technologies"
              required
            />
          </div>

          <div>
            <label htmlFor="slug">{t("copy.auth.signup.slug_label")}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="subtle" style={{ whiteSpace: "nowrap" }}>/</span>
              <input
                id="slug"
                type="text"
                value={effectiveSlug}
                onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }}
                placeholder="acme"
                required
              />
            </div>
            <p className="subtle" style={{ marginTop: 5 }}>{t("copy.auth.signup.slug_help")}</p>
          </div>

          <div>
            <label htmlFor="email">{t("copy.auth.signup.email_label")}</label>
            <input
              id="email"
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              required
            />
          </div>

          <div>
            <label htmlFor="password">{t("copy.auth.signup.password_label")}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={passwordMinLength}
              required
            />
            <p className="subtle" style={{ marginTop: 5 }}>{t("copy.auth.signup.password_help", { min: passwordMinLength })}</p>
          </div>

          <button type="submit" className="primary" disabled={loading} style={{ width: "100%" }}>
            {loading ? t("copy.auth.signup.submitting") : t("copy.auth.signup.submit")}
          </button>
        </form>

        <p className="muted" style={{ marginTop: 20, textAlign: "center", fontSize: 13 }}>
          {t("copy.auth.signup.have_account")} <Link href="/login">{t("copy.auth.signup.login_link")}</Link>
        </p>
      </div>
    </main>
  );
}
