"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatInr } from "@pratibha/shared";
import { openPaymentCheckout, openSubscriptionCheckout } from "@/lib/cashfree-checkout";
import { useCopy, useRichCopy } from "@/lib/copy-client";

interface Plan {
  id: string;
  key?: string;
  name: string;
  priceInr: number;
  /** Display only: shown struck through. The sale price is the only one ever charged. */
  slashedPriceInr?: number | null;
  limits: { roles: number | null; interviews: number; interviewMinutes: number; screenings: number };
}

interface Payload {
  subscription: {
    id: string;
    planId: string;
    status: string;
    periodEnd: string;
    topUpMinutes: number;
    cancelRequestedAt: string | null;
    billingContactEmail: string | null;
    billingContactPrefs: Record<string, boolean> | null;
  };
  plan: Plan | null;
  plans: Plan[];
  minutes: {
    used: number;
    limit: number | null;
    remaining: number | null;
    level: null | "warning" | "exhausted";
    planMinutes: number | null;
    topUpMinutes: number;
    approximateInterviewsRemaining: number | null;
  };
  overageMinutes: number;
  daysRemaining: number;
  methods: Array<{ id: string; provider: string; brand: string | null; last4: string | null; mandateStatus: string; isDefault: boolean }>;
  invoices: Array<{ id: string; number: string; status: string; issuedAt: string; totalPaise: number }>;
  billingDetails: { legalName: string | null; billingAddress: string | null; billingState: string | null; gstin: string | null } | null;
  topUpPacks: Array<{ id: string; kind: "minutes" | "screenings"; quantity: number; minutes: number; pricePaise: number }>;
  gateway: { name: string; canCharge: boolean; mode: "sandbox" | "production" | null };
  canManage: boolean;
  /** Days a cancelled workspace's data is kept (admin setting). */
  retentionDays?: number;
  billingPhone: string | null;
  checkoutStatus: "paid" | "pending" | "failed" | null;
}

/**
 * Subscriptions.
 *
 * The meter leads, and nothing is allowed above it. A surprise overage is the
 * fastest way to lose a customer, so how many minutes are left and when they
 * reset is the first thing on the page — the plan name, which people already
 * know, comes after.
 */
export default function SubscriptionPage({ params }: { params: { tenant: string } }) {
  const t = useCopy();
  const rich = useRichCopy();
  const { tenant } = params;

  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [coupon, setCoupon] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("too_expensive");
  const [cancelComment, setCancelComment] = useState("");
  const [autopayPhone, setAutopayPhone] = useState("");

  const load = useCallback(async () => {
    // Back from Cashfree's checkout: pass the reference on once so the server
    // checks the mandate's status, then drop it from the address bar.
    // Back from a one-time checkout too: the server settles it if paid.
    const search = new URLSearchParams(window.location.search);
    const returned = search.get("autopay");
    const orderId = search.get("order_id");
    const query = returned ? `?autopay=${encodeURIComponent(returned)}` : orderId ? `?order_id=${encodeURIComponent(orderId)}` : "";
    const res = await fetch(`/api/${tenant}/subscription${query}`);
    if (query) window.history.replaceState(null, "", window.location.pathname);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.message || "Could not load your subscription");
      return;
    }
    setData(body);
    setAutopayPhone((p) => p || body.billingPhone || "");
    if (body.checkoutStatus === "paid") setMessage("Payment received. Your purchase is applied and the invoice is marked paid.");
    else if (body.checkoutStatus === "pending") setMessage("Payment is being confirmed by your bank. This page will show it once it lands; refresh in a minute.");
    else if (body.checkoutStatus === "failed") setError("The payment did not go through, so nothing was charged. Try again.");
    setContactEmail(body.subscription?.billingContactEmail ?? "");
  }, [tenant]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * A purchase: with Cashfree connected the server answers with a checkout to
   * open, and the purchase applies when the payment lands. Without it, the
   * old behaviour (recorded now, settled by the team) stands.
   */
  async function buy(url: string, payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, ...(autopayPhone.trim() ? { phone: autopayPhone.trim() } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || "That did not work");
        return;
      }
      if (body.checkout?.paymentSessionId) {
        const failed = await openPaymentCheckout(body.checkout.paymentSessionId, body.checkout.mode);
        if (failed) setError(failed);
        return;
      }
      setMessage(body.note ?? body.message ?? "Saved.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(url: string, init: RequestInit, note?: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(url, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || "That did not work");
        return null;
      }
      setMessage(note ?? body.note ?? body.message ?? "Saved.");
      await load();
      return body;
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="card empty">
        {error ? <p className="notice notice-error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  async function setUpAutopay() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/subscription/mandate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: autopayPhone }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || "Could not start AutoPay");
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

  const { minutes, subscription } = data;
  const hasActiveMandate = data.methods.some((m) => m.mandateStatus === "active");
  // A trial buys a plan rather than switching between them.
  const onTrial = subscription.status === "trialing";
  const needsPhone = data.gateway.name === "cashfree" && data.canManage && !data.billingPhone;
  const pct = minutes.limit ? Math.min(100, (minutes.used / minutes.limit) * 100) : 0;

  return (
    <div className="dash" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <h1>{t("copy.portal.subscription.title")}</h1>
      </div>

      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}

      {/* ---- The meter, first and largest --------------------------------- */}
      <section className="card meter-hero" style={{ marginBottom: 16 }}>
        {minutes.limit === null ? (
          <p className="muted" style={{ margin: 0 }}>{t("copy.portal.subscription.no_limit")}</p>
        ) : (
          <>
            <div className="meter-figure">
              <strong>{minutes.remaining}</strong>
              <span>minutes left of {minutes.limit}</span>
            </div>

            <div className="track lg">
              <div className={`fill${minutes.level ? ` ${minutes.level}` : ""}`} style={{ width: `${pct}%` }} />
            </div>

            <p className="meter-sub">
              {minutes.used} used · resets in {data.daysRemaining}{" "}
              {data.daysRemaining === 1 ? "day" : "days"}
              {/* Customers think in interviews and are billed in minutes.
                  Always "roughly": it is an estimate, and saying so is what
                  stops it being quoted back at us. */}
              {minutes.approximateInterviewsRemaining !== null &&
                ` · roughly ${minutes.approximateInterviewsRemaining} interviews`}
              {minutes.topUpMinutes > 0 && ` · includes ${minutes.topUpMinutes} topped up`}
            </p>

            {data.overageMinutes > 0 && (
              <div className="notice notice-error" style={{ marginTop: 12 }}>
                {t("copy.portal.subscription.overage", { minutes: data.overageMinutes })}
              </div>
            )}
            {minutes.level === "warning" && (
              <div className="notice notice-info" style={{ marginTop: 12 }}>
                {t("copy.portal.subscription.usage_warning", { percent: Math.round(pct) })}
              </div>
            )}
          </>
        )}
      </section>

      {subscription.cancelRequestedAt && (
        <div className="notice notice-error" style={{ marginBottom: 16 }}>
          {rich("copy.portal.subscription.cancel_scheduled", {
            date: new Date(subscription.periodEnd).toLocaleDateString("en-IN"),
            days: data.retentionDays ?? 30,
          })}
          {data.canManage && (
            <button
              className="sm"
              style={{ marginLeft: 10 }}
              disabled={busy}
              onClick={() =>
                act(`/api/${tenant}/subscription/cancel`, { method: "DELETE" }, "Cancellation reversed.")
              }
            >
              {t("copy.portal.subscription.keep_button")}
            </button>
          )}
        </div>
      )}

      {needsPhone && (
        // Cashfree needs a mobile number for every payment; asked once, kept.
        <section className="card" style={{ marginBottom: 16 }}>
          <label htmlFor="pay-phone" style={{ fontWeight: 600 }}>{t("copy.portal.subscription.phone_label")}</label>
          <input
            id="pay-phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            placeholder="98765 43210"
            value={autopayPhone}
            onChange={(e) => setAutopayPhone(e.target.value)}
            style={{ maxWidth: 240, display: "block", marginTop: 6 }}
          />
          <p className="subtle field-hint" style={{ marginBottom: 0 }}>
            {t("copy.portal.subscription.phone_help")}
          </p>
        </section>
      )}

      {/* ---- Plan --------------------------------------------------------- */}
      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{t("copy.portal.subscription.plan_heading")}</h3>
        <div className="plan-grid">
          {data.plans.map((plan) => {
            // Plans on sale are keyed by plan; the workspace may be on an older,
            // grandfathered version of the same one.
            const current = plan.id === (data.plan?.key ?? subscription.planId);
            return (
              <div key={plan.id} className={`plan-card${current ? " current" : ""}`}>
                <div className="plan-name">{plan.name}</div>
                <div className="plan-price">
                  {plan.slashedPriceInr ? (
                    <s style={{ opacity: 0.55, fontWeight: 500, marginRight: 6 }}>₹{plan.slashedPriceInr.toLocaleString("en-IN")}</s>
                  ) : null}
                  ₹{plan.priceInr.toLocaleString("en-IN")}<span>/mo</span>
                </div>
                <ul className="plan-limits">
                  <li>{plan.limits.interviewMinutes} interview minutes</li>
                  <li>{plan.limits.screenings} CV screenings</li>
                  <li>{plan.limits.roles === null ? "Unlimited roles" : `${plan.limits.roles} roles`}</li>
                </ul>
                {current && !onTrial ? (
                  <span className="badge badge-accent">{t("copy.portal.subscription.current_plan")}</span>
                ) : (
                  <button
                    className="sm"
                    disabled={!data.canManage || busy}
                    title={data.canManage ? undefined : t("copy.portal.subscription.owner_only")}
                    onClick={() =>
                      buy(`/api/${tenant}/subscription/plan`, { planId: plan.id })
                    }
                  >
                    {onTrial ? "Buy" : data.plan && plan.priceInr > data.plan.priceInr ? "Upgrade" : "Downgrade"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ---- Payment ------------------------------------------------------ */}
      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{t("copy.portal.subscription.payment_heading")}</h3>
        {!data.gateway.canCharge ? (
          // Said rather than hidden: a disabled button with no explanation
          // reads as broken.
          <p className="subtle" style={{ margin: 0 }}>
            {t("copy.portal.subscription.no_gateway")}
          </p>
        ) : (
          <>
            {data.methods.filter((m) => m.mandateStatus !== "revoked").length === 0 ? (
              <p className="subtle" style={{ marginTop: 0 }}>{t("copy.portal.subscription.no_method")}</p>
            ) : (
              <ul className="method-list">
                {data.methods
                  .filter((m) => m.mandateStatus !== "revoked")
                  .map((m) => (
                    <li key={m.id}>
                      <span>{m.brand ?? "AutoPay"}{m.last4 ? ` •••• ${m.last4}` : ""}</span>
                      <span className={`badge ${m.mandateStatus === "active" ? "badge-success" : "badge-warning"}`}>
                        {m.mandateStatus === "active" ? "AutoPay on" : m.mandateStatus === "pending" ? "awaiting approval" : `mandate ${m.mandateStatus}`}
                      </span>
                      {data.canManage && m.mandateStatus !== "failed" && (
                        <button
                          type="button"
                          className="sm ghost"
                          disabled={busy}
                          onClick={() =>
                            act(
                              `/api/${tenant}/subscription/mandate`,
                              {
                                method: "DELETE",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({ methodId: m.id }),
                              }
                            )
                          }
                        >
                          Turn off
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
            )}
            {data.canManage && !hasActiveMandate && (
              <form
                style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void setUpAutopay();
                }}
              >
                <input
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  placeholder="Mobile number for AutoPay"
                  value={autopayPhone}
                  onChange={(e) => setAutopayPhone(e.target.value)}
                  style={{ maxWidth: 240 }}
                />
                <button type="submit" className="sm primary" disabled={busy || !autopayPhone.trim()}>
                  {t("copy.portal.subscription.autopay_button")}
                </button>
              </form>
            )}
            <p className="subtle field-hint" style={{ marginBottom: 0 }}>
              {t("copy.portal.subscription.autopay_help")}
            </p>
          </>
        )}
      </section>

      {/* ---- Billing details, from Company profile ------------------------ */}
      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{t("copy.portal.subscription.billing_heading")}</h3>
        <p className="subtle field-hint" style={{ marginTop: 0 }}>
          {t("copy.portal.subscription.billing_help_before")}{" "}
          <Link href={`/${tenant}/settings/company`}>{t("copy.portal.subscription.billing_help_link")}</Link>
          {t("copy.portal.subscription.billing_help_after")}
        </p>
        <dl className="detail-list">
          <dt>Legal name</dt><dd>{data.billingDetails?.legalName ?? <em>not set</em>}</dd>
          <dt>GSTIN</dt><dd>{data.billingDetails?.gstin ?? <em>not set</em>}</dd>
          <dt>State</dt><dd>{data.billingDetails?.billingState ?? <em>not set</em>}</dd>
          <dt>Address</dt><dd>{data.billingDetails?.billingAddress ?? <em>not set</em>}</dd>
        </dl>
      </section>

      {/* ---- Billing contact ---------------------------------------------- */}
      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{t("copy.portal.subscription.contact_heading")}</h3>
        <p className="subtle field-hint" style={{ marginTop: 0 }}>
          {t("copy.portal.subscription.contact_help")}
        </p>
        <div className="row" style={{ gap: 8 }}>
          <input
            type="email"
            value={contactEmail}
            placeholder="finance@yourcompany.com"
            onChange={(e) => setContactEmail(e.target.value)}
            disabled={!data.canManage}
            style={{ flex: 1, minWidth: 220 }}
          />
          <button
            className="sm"
            disabled={!data.canManage || busy}
            onClick={() =>
              act(
                `/api/${tenant}/subscription/billing-contact`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ email: contactEmail || null }),
                },
                "Billing contact saved."
              )
            }
          >
            Save
          </button>
        </div>
      </section>

      {/* ---- Top-ups and coupons ------------------------------------------ */}
      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{t("copy.portal.subscription.topup_heading")}</h3>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          {data.topUpPacks.map((pack) => (
            <button
              key={pack.id}
              className="btn"
              disabled={!data.canManage || busy}
              onClick={() =>
                buy(`/api/${tenant}/subscription/top-up`, { packId: pack.id })
              }
            >
              {pack.quantity} {pack.kind === "minutes" ? "minutes" : "CV screenings"} — {formatInr(pack.pricePaise)}
            </button>
          ))}
        </div>

        <h4 style={{ marginBottom: 6, marginTop: 20 }}>{t("copy.portal.subscription.coupon_heading")}</h4>
        <div className="row" style={{ gap: 8 }}>
          <input
            value={coupon}
            placeholder="CODE"
            onChange={(e) => setCoupon(e.target.value.toUpperCase())}
            disabled={!data.canManage}
            style={{ maxWidth: 220 }}
          />
          <button
            className="sm"
            disabled={!data.canManage || busy || !coupon.trim()}
            onClick={async () => {
              const ok = await act(`/api/${tenant}/subscription/coupon`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: coupon }),
              });
              if (ok) setCoupon("");
            }}
          >
            Redeem
          </button>
        </div>
      </section>

      {/* ---- Invoices ----------------------------------------------------- */}
      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{t("copy.portal.subscription.invoices_heading")}</h3>
        {data.invoices.length === 0 ? (
          <p className="subtle" style={{ margin: 0 }}>{t("copy.portal.subscription.invoices_empty")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Number</th><th>Date</th><th>Amount</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {data.invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{inv.number}</td>
                    <td>{new Date(inv.issuedAt).toLocaleDateString("en-IN")}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{formatInr(inv.totalPaise)}</td>
                    <td><span className="badge badge-neutral">{inv.status}</span></td>
                    <td style={{ textAlign: "right" }}>
                      <Link className="sm ghost" href={`/${tenant}/settings/subscription/invoices/${inv.id}`}>
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---- Cancel -------------------------------------------------------- */}
      {data.canManage && !subscription.cancelRequestedAt && (
        <section className="card danger-zone">
          <h3 style={{ marginTop: 0 }}>{t("copy.portal.subscription.cancel_heading")}</h3>
          {!cancelling ? (
            <button className="sm" onClick={() => setCancelling(true)}>{t("copy.portal.subscription.cancel_button")}</button>
          ) : (
            <div className="stack">
              {/* Stated before the button, not after: the consequences are the
                  decision, and finding them out afterwards is too late. */}
              <div className="notice notice-error">
                {rich("copy.portal.subscription.cancel_warning", {
                  date: new Date(subscription.periodEnd).toLocaleDateString("en-IN"),
                  days: data.retentionDays ?? 30,
                })}
              </div>

              <label>
                <span>{t("copy.portal.subscription.cancel_reason_label")}</span>
                <select value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}>
                  <option value="too_expensive">{t("copy.portal.subscription.cancel_reason.too_expensive")}</option>
                  <option value="not_enough_hiring">{t("copy.portal.subscription.cancel_reason.not_enough_hiring")}</option>
                  <option value="missing_features">{t("copy.portal.subscription.cancel_reason.missing_features")}</option>
                  <option value="quality">{t("copy.portal.subscription.cancel_reason.quality")}</option>
                  <option value="switched">{t("copy.portal.subscription.cancel_reason.switched")}</option>
                  <option value="other">{t("copy.portal.subscription.cancel_reason.other")}</option>
                </select>
              </label>

              <label>
                <span>{t("copy.portal.subscription.cancel_comment_label")}</span>
                <textarea rows={3} value={cancelComment} onChange={(e) => setCancelComment(e.target.value)} />
              </label>

              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button className="sm" onClick={() => setCancelling(false)}>{t("copy.portal.subscription.cancel_keep")}</button>
                <button
                  className="sm danger"
                  disabled={busy}
                  onClick={() =>
                    act(
                      `/api/${tenant}/subscription/cancel`,
                      {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ reason: cancelReason, comment: cancelComment || undefined }),
                      },
                      t("copy.portal.subscription.cancel_done")
                    )
                  }
                >
                  {t("copy.portal.subscription.cancel_confirm")}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
