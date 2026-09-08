"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import ThemeToggle from "@/components/ThemeToggle";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      setError("This login is not linked to a workspace. Sign up to create one, or ask your admin for an invite.");
    } else {
      setError("Could not determine your workspace. Please try again.");
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

        <h1 style={{ fontSize: 21 }}>Welcome back</h1>
        <p className="muted" style={{ marginBottom: 22 }}>
          Log in to your hiring workspace.
        </p>

        <form onSubmit={handleSubmit} className="stack">
          {error && <div className="notice notice-error">{error}</div>}

          <div>
            <label htmlFor="email">Work email</label>
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
            <label htmlFor="password">Password</label>
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
            {loading ? "Logging in…" : "Log in"}
          </button>
        </form>

        <p className="muted" style={{ marginTop: 20, textAlign: "center", fontSize: 13 }}>
          Don&apos;t have an account? <Link href="/signup">Create a workspace</Link>
        </p>
      </div>
    </main>
  );
}
