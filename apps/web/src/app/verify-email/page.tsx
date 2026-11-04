"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCopy } from "@/lib/copy-client";

export default function VerifyEmailPage() {
  const router = useRouter();
  const t = useCopy();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resendEmail, setResendEmail] = useState("");
  const [resend, setResend] = useState<"idle" | "busy" | "done">("idle");

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
        setError(data.message || t("copy.auth.verify.error_failed"));
        return;
      }

      // TODO: backend should return the user's tenant slug so we can redirect to the tenant dashboard.
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }

  // A new confirmation link from Pratibha's mailbox. The answer is the same
  // for every address, so this cannot be used to find out who has an account.
  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    setResend("busy");
    try {
      await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resendEmail }),
      });
    } finally {
      setResend("done");
    }
  }

  return (
    <main style={{ maxWidth: 420, margin: "48px auto", padding: 24 }}>
      <div className="page-head"><h1>{t("copy.auth.verify.title")}</h1></div>
      <form onSubmit={handleSubmit}>
        {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="code">{t("copy.auth.verify.code_label")}</label>
          <input
            id="code"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            
          />
        </div>
        <button type="submit" disabled={loading} className="primary">
          {loading ? t("copy.auth.verify.submitting") : t("copy.auth.verify.submit")}
        </button>
      </form>

      <form onSubmit={handleResend} style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>{t("copy.auth.verify.resend_heading")}</h2>
        {resend === "done" && <div className="notice notice-info" style={{ marginBottom: 16 }}>{t("copy.auth.verify.resend_sent")}</div>}
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="resend-email">{t("copy.auth.verify.resend_email_label")}</label>
          <input
            id="resend-email"
            type="email"
            value={resendEmail}
            onChange={(e) => setResendEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>
        <button type="submit" disabled={resend === "busy"}>
          {resend === "busy" ? t("copy.auth.verify.resend_submitting") : t("copy.auth.verify.resend_submit")}
        </button>
      </form>
    </main>
  );
}
