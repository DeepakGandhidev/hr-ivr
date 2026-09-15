"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatInr } from "@pratibha/shared";

interface Plan {
  id: string;
  name: string;
  priceInr: number;
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
  topUpPacks: Array<{ minutes: number; pricePaise: number }>;
  gateway: { name: string; canCharge: boolean };
  canManage: boolean;
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

  const load = useCallback(async () => {
    const res = await fetch(`/api/${tenant}/subscription`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.message || "Could not load your subscription");
      return;
    }
    setData(body);
    setContactEmail(body.subscription?.billingContactEmail ?? "");
  }, [tenant]);

  useEffect(() => {
    load();
  }, [load]);

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

  const { minutes, subscription } = data;
  const pct = minutes.limit ? Math.min(100, (minutes.used / minutes.limit) * 100) : 0;

  return (
    <div className="dash" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <h1>Subscription</h1>
      </div>

      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}

      {/* ---- The meter, first and largest --------------------------------- */}
      <section className="card meter-hero" style={{ marginBottom: 16 }}>
        {minutes.limit === null ? (
          <p className="muted" style={{ margin: 0 }}>This plan has no minute limit.</p>
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
                {data.overageMinutes} minutes used beyond your plan this period.
              </div>
            )}
            {minutes.level === "warning" && (
              <div className="notice notice-info" style={{ marginTop: 12 }}>
                You have used {Math.round(pct)}% of your minutes.
              </div>
            )}
          </>
        )}
      </section>

      {subscription.cancelRequestedAt && (
        <div className="notice notice-error" style={{ marginBottom: 16 }}>
          <strong>Scheduled to end</strong> on{" "}
          {new Date(subscription.periodEnd).toLocaleDateString("en-IN")}. Your data
          becomes read-only then and is deleted 30 days later.
          {data.canManage && (
            <button
              className="sm"
              style={{ marginLeft: 10 }}
              disabled={busy}
              onClick={() =>
                act(`/api/${tenant}/subscription/cancel`, { method: "DELETE" }, "Cancellation reversed.")
              }
            >
              Keep my subscription
            </button>
          )}
        </div>
      )}

      {/* ---- Plan --------------------------------------------------------- */}
      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Plan</h3>
        <div className="plan-grid">
          {data.plans.map((plan) => {
            const current = plan.id === subscription.planId;
            return (
              <div key={plan.id} className={`plan-card${current ? " current" : ""}`}>
                <div className="plan-name">{plan.name}</div>
                <div className="plan-price">₹{plan.priceInr.toLocaleString("en-IN")}<span>/mo</span></div>
                <ul className="plan-limits">
                  <li>{plan.limits.interviewMinutes} interview minutes</li>
                  <li>{plan.limits.screenings} CV screenings</li>
                  <li>{plan.limits.roles === null ? "Unlimited roles" : `${plan.limits.roles} roles`}</li>
                </ul>
                {current ? (
                  <span className="badge badge-accent">Current plan</span>
                ) : (
                  <button
                    className="sm"
                    disabled={!data.canManage || busy}
                    title={data.canManage ? undefined : "Only the workspace owner can change the plan"}
                    onClick={() =>
                      act(`/api/${tenant}/subscription/plan`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ planId: plan.id }),
                      })
                    }
                  >
                    {data.plan && plan.priceInr > data.plan.priceInr ? "Upgrade" : "Downgrade"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ---- Payment ------------------------------------------------------ */}
      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Payment method</h3>
        {!data.gateway.canCharge ? (
          // Said rather than hidden: a disabled button with no explanation
          // reads as broken.
          <p className="subtle" style={{ margin: 0 }}>
            No payment gateway is connected yet. Plan changes are recorded here
            and actioned by the Pratibha team.
          </p>
        ) : data.methods.length === 0 ? (
          <p className="subtle" style={{ margin: 0 }}>No payment method saved.</p>
        ) : (
          <ul className="method-list">
            {data.methods.map((m) => (
              <li key={m.id}>
                <span>{m.brand ?? m.provider} •••• {m.last4 ?? "????"}</span>
                <span className={`badge ${m.mandateStatus === "active" ? "badge-success" : "badge-warning"}`}>
                  mandate {m.mandateStatus}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- Billing details, from Company profile ------------------------ */}
      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Billing details</h3>
        <p className="subtle field-hint" style={{ marginTop: 0 }}>
          Taken from <Link href={`/${tenant}/settings/company`}>Company profile</Link>,
          so there is one source of truth. These appear on every invoice.
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
        <h3 style={{ marginTop: 0 }}>Billing contact</h3>
        <p className="subtle field-hint" style={{ marginTop: 0 }}>
          Invoices go here as well as to the owner. This is an email address, not
          a login — they will not be able to see candidates or hiring data.
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
        <h3 style={{ marginTop: 0 }}>Buy more minutes</h3>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          {data.topUpPacks.map((pack) => (
            <button
              key={pack.minutes}
              className="btn"
              disabled={!data.canManage || busy}
              onClick={() =>
                act(`/api/${tenant}/subscription/top-up`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ minutes: pack.minutes }),
                })
              }
            >
              {pack.minutes} minutes — {formatInr(pack.pricePaise)}
            </button>
          ))}
        </div>

        <h4 style={{ marginBottom: 6, marginTop: 20 }}>Have a coupon?</h4>
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
        <h3 style={{ marginTop: 0 }}>Invoices</h3>
        {data.invoices.length === 0 ? (
          <p className="subtle" style={{ margin: 0 }}>No invoices yet.</p>
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
          <h3 style={{ marginTop: 0 }}>Cancel subscription</h3>
          {!cancelling ? (
            <button className="sm" onClick={() => setCancelling(true)}>Cancel subscription</button>
          ) : (
            <div className="stack">
              {/* Stated before the button, not after: the consequences are the
                  decision, and finding them out afterwards is too late. */}
              <div className="notice notice-error">
                <strong>What happens:</strong> you keep full access until{" "}
                {new Date(subscription.periodEnd).toLocaleDateString("en-IN")}. After
                that your workspace becomes <strong>read-only</strong> — you can
                still read candidates, transcripts and reports, but not run new
                interviews. <strong>30 days later the data is deleted</strong> and
                cannot be recovered.
              </div>

              <label>
                <span>Why are you leaving?</span>
                <select value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}>
                  <option value="too_expensive">Too expensive</option>
                  <option value="not_enough_hiring">Not hiring enough to justify it</option>
                  <option value="missing_features">Missing features we need</option>
                  <option value="quality">Interview quality did not meet our bar</option>
                  <option value="switched">Moved to another product</option>
                  <option value="other">Something else</option>
                </select>
              </label>

              <label>
                <span>Anything else? (optional)</span>
                <textarea rows={3} value={cancelComment} onChange={(e) => setCancelComment(e.target.value)} />
              </label>

              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button className="sm" onClick={() => setCancelling(false)}>Keep it</button>
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
                      "Your subscription will end at the close of this period."
                    )
                  }
                >
                  Confirm cancellation
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
