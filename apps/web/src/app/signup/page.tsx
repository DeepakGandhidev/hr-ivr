"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";

/** Mirrors the slug rules the API enforces, so the field cannot produce one it rejects. */
function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export default function SignupPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The slug follows the company name until someone edits it themselves —
  // asking a new user to invent a URL slug from nothing is a needless step.
  const effectiveSlug = slugTouched ? slug : slugify(companyName);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Use a password of at least 8 characters.");
      return;
    }
    if (!effectiveSlug) {
      setError("Enter a workspace name.");
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
        setError(data.message || "Signup failed");
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

  return (
    <main className="auth-wrap">
      {/* No sidebar on the auth screens, so the toggle floats. */}
      <ThemeToggle floating />
      <div className="auth-card">
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 22 }}>
          <span className="brand-mark">P</span>
          <strong style={{ fontSize: 15 }}>Pratibha</strong>
        </div>

        <h1 style={{ fontSize: 21 }}>Create your workspace</h1>
        <p className="muted" style={{ marginBottom: 22 }}>
          Start screening candidates automatically. No card required.
        </p>

        <form onSubmit={handleSubmit} className="stack">
          {error && <div className="notice notice-error">{error}</div>}

          <div>
            <label htmlFor="company">Company name</label>
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
            <label htmlFor="slug">Workspace URL</label>
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
            <p className="subtle" style={{ marginTop: 5 }}>Lowercase letters, numbers and hyphens.</p>
          </div>

          <div>
            <label htmlFor="email">Your work email</label>
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
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
            <p className="subtle" style={{ marginTop: 5 }}>At least 8 characters.</p>
          </div>

          <button type="submit" className="primary" disabled={loading} style={{ width: "100%" }}>
            {loading ? "Creating workspace…" : "Create workspace"}
          </button>
        </form>

        <p className="muted" style={{ marginTop: 20, textAlign: "center", fontSize: 13 }}>
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </div>
    </main>
  );
}
