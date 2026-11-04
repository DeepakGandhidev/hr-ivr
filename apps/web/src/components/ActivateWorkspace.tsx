"use client";

import { useEffect, useState } from "react";
import { formatInr } from "@pratibha/shared";
import { openSubscriptionCheckout } from "@/lib/cashfree-checkout";
import { useCopy } from "@/lib/copy-client";

interface PublicPlan {
  key: "starter" | "growth" | "scale";
  name: string;
  priceInr: number;
  slashedPriceInr: number | null;
  minutes: number;
  screenings: number;
  jobLimit: number | null;
}

/**
 * The only screen an unpaid workspace opens: choose a plan, pay the first month
 * and approve AutoPay in one Cashfree checkout. Prices come from the public
 * pricing feed, the same one the website reads, so the two cannot disagree.
 */
export function ActivateWorkspace({ tenant, name, isOwner, gstRatePercent = 18 }: { tenant: string; name: string; isOwner: boolean; gstRatePercent?: number }) {
  const t = useCopy();
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [plan, setPlan] = useState<PublicPlan["key"]>("starter");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/public/pricing")
      .then((r) => r.json())
      .then((body) => setPlans(body.plans ?? []))
      .catch(() => setError(t("copy.portal.activate.error_plans")));
  }, [t]);

  // Back from Cashfree: confirm the payment, then let them in.
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("autopay");
    if (!ref) return;
    setChecking(true);
    let tries = 0;
    const check = async () => {
      tries++;
      const res = await fetch(`/api/${tenant}/subscription/activate?ref=${encodeURIComponent(ref)}`);
      const body = await res.json().catch(() => ({}));
      if (body.status && body.status !== "pending_payment") {
        window.location.replace(`/${tenant}`);
        return;
      }
      if (body.lastAttempt === "failed") {
        setChecking(false);
        setError(t("copy.portal.activate.error_payment_failed"));
        window.history.replaceState(null, "", window.location.pathname);
        return;
      }
      if (tries < 10) setTimeout(check, 3000);
      else {
        setChecking(false);
        setError(t("copy.portal.activate.error_bank_pending"));
      }
    };
    void check();
  }, [tenant, t]);

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/${tenant}/subscription/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, phone }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || t("copy.portal.activate.error_start"));
        return;
      }
      if (body.redirectUrl) {
        window.location.href = body.redirectUrl;
        return;
      }
      const failed = await openSubscriptionCheckout(body.sessionId, body.mode);
      if (failed) setError(failed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const chosen = plans.find((p) => p.key === plan);
  const totalPaise = chosen ? Math.round(chosen.priceInr * 118) : 0;

  return (
    <main className="auth-wrap">
      <div className="auth-card" style={{ maxWidth: 560 }}>
        <h1 style={{ fontSize: 21 }}>{t("copy.portal.activate.title", { company: name })}</h1>
        {checking ? (
          <p className="muted">{t("copy.portal.activate.checking")}</p>
        ) : !isOwner ? (
          <p className="muted">
            {t("copy.portal.activate.not_owner")}
          </p>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 18 }}>
              {t("copy.portal.activate.intro")}
            </p>
            <form onSubmit={pay} className="stack">
              {error && <div className="notice notice-error">{error}</div>}
              <div className="stack" style={{ gap: 8 }}>
                {plans.map((p) => (
                  <label
                    key={p.key}
                    className="card"
                    style={{
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                      padding: 14,
                      cursor: "pointer",
                      borderColor: plan === p.key ? "var(--accent)" : undefined,
                    }}
                  >
                    <input type="radio" name="plan" value={p.key} checked={plan === p.key} onChange={() => setPlan(p.key)} />
                    <span style={{ flex: 1 }}>
                      <strong>{p.name}</strong>
                      <span className="subtle" style={{ display: "block", fontSize: 13 }}>
                        {p.minutes} interview minutes · {p.screenings} CV screenings · {p.jobLimit === null ? "unlimited" : p.jobLimit} open{" "}
                        {p.jobLimit === 1 ? "job" : "jobs"}
                      </span>
                    </span>
                    <span style={{ textAlign: "right" }}>
                      {p.slashedPriceInr ? (
                        <s className="subtle" style={{ display: "block", fontSize: 12 }}>{formatInr(p.slashedPriceInr * 100)}</s>
                      ) : null}
                      <strong>{formatInr(p.priceInr * 100)}</strong>
                      <span className="subtle" style={{ fontSize: 12 }}>/mo</span>
                    </span>
                  </label>
                ))}
              </div>
              <div>
                <label htmlFor="activate-phone">{t("copy.portal.activate.phone_label")}</label>
                <input
                  id="activate-phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  placeholder="98765 43210"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                />
                <p className="subtle" style={{ marginTop: 5 }}>{t("copy.portal.activate.phone_help")}</p>
              </div>
              <button type="submit" className="primary" disabled={busy || !chosen} style={{ width: "100%" }}>
                {busy
                  ? t("copy.portal.activate.submitting")
                  : chosen
                    ? t("copy.portal.activate.submit_amount", { amount: formatInr(totalPaise) })
                    : t("copy.portal.activate.submit")}
              </button>
              <p className="subtle" style={{ margin: 0, fontSize: 12, textAlign: "center" }}>
                {t("copy.portal.activate.footer", { gst: gstRatePercent })}
              </p>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
