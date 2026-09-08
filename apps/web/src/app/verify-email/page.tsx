"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function VerifyEmailPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: code, type: "email" }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Verification failed");
        return;
      }

      // TODO: backend should return the user's tenant slug so we can redirect to the tenant dashboard.
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 420, margin: "48px auto", padding: 24 }}>
      <div className="page-head"><h1>Verify your email</h1></div>
      <form onSubmit={handleSubmit}>
        {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="code">Verification code</label>
          <input
            id="code"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            
          />
        </div>
        <button type="submit" disabled={loading} className="primary">
          {loading ? "Verifying..." : "Verify"}
        </button>
      </form>
    </main>
  );
}
