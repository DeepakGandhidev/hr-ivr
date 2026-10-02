"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { ActionMenu, Dialog, ReasonField, useToast } from "@/components/ui";

const METHODS = [
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
];

type Ws = { id: string; name: string; status: string; planName: string; priceInr: number; version: number };

export function RecordPaymentButton({
  workspaces,
  packs,
  defaultWorkspace,
}: {
  workspaces: Ws[];
  packs: { id: string; label: string; priceInr: number }[];
  defaultWorkspace?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [wsId, setWsId] = useState(defaultWorkspace ?? workspaces[0]?.id ?? "");
  const [kind, setKind] = useState<"subscription" | "top_up">("subscription");
  const [status, setStatus] = useState<"captured" | "failed">("captured");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("upi");
  const [reference, setReference] = useState("");
  const [coupon, setCoupon] = useState("");
  const [packId, setPackId] = useState(packs[0]?.id ?? "");
  const [paidOn, setPaidOn] = useState("");
  const [retryOn, setRetryOn] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ws = workspaces.find((w) => w.id === wsId);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>("/api/payments", {
        workspaceId: wsId,
        kind,
        status,
        amountInr: amount ? Number(amount) : null,
        method,
        reference: reference || null,
        couponCode: coupon || null,
        packId: kind === "top_up" ? packId : null,
        paidOn: paidOn || null,
        retryOn: retryOn || null,
        reason: reason || null,
      });
      setOpen(false);
      toast.show(res.message);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-primary" onClick={() => setOpen(true)}>Record payment</button>
      {open && (
        <Dialog title="Record a payment" onClose={() => setOpen(false)} busy={busy} width={560}>
          <div className="field">
            <label className="label" htmlFor="rp-ws">Workspace</label>
            <select id="rp-ws" className="select" value={wsId} onChange={(e) => setWsId(e.target.value)}>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div className="choice">
            <label className={kind === "subscription" ? "on" : ""}>
              <input type="radio" checked={kind === "subscription"} onChange={() => setKind("subscription")} />
              <b>Subscription</b><span className="hint">The monthly plan charge</span>
            </label>
            <label className={kind === "top_up" ? "on" : ""}>
              <input type="radio" checked={kind === "top_up"} onChange={() => { setKind("top_up"); setStatus("captured"); }} />
              <b>Top up pack</b><span className="hint">Adds the pack to their meter</span>
            </label>
          </div>
          {kind === "subscription" ? (
            <>
              <div className="choice">
                <label className={status === "captured" ? "on" : ""}>
                  <input type="radio" checked={status === "captured"} onChange={() => setStatus("captured")} />
                  <b>Paid</b><span className="hint">Captured, with an invoice</span>
                </label>
                <label className={status === "failed" ? "on" : ""}>
                  <input type="radio" checked={status === "failed"} onChange={() => setStatus("failed")} />
                  <b>Failed</b><span className="hint">Puts the workspace past due</span>
                </label>
              </div>
              <div className="grid-2" style={{ gap: 10 }}>
                <div className="field">
                  <label className="label" htmlFor="rp-amt">Amount, ₹ before GST</label>
                  <input id="rp-amt" className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder={ws ? String(ws.priceInr) : ""} />
                  {ws && <span className="hint">Blank charges their own price: {ws.planName} at ₹{ws.priceInr.toLocaleString("en-IN")}{ws.version > 1 ? `, version ${ws.version}` : ""}.</span>}
                </div>
                {status === "captured" ? (
                  <div className="field">
                    <label className="label" htmlFor="rp-coupon">Coupon, optional</label>
                    <input id="rp-coupon" className="input mono" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} placeholder="FIRSTHIRE" />
                  </div>
                ) : (
                  <div className="field">
                    <label className="label" htmlFor="rp-retry">Next retry, optional</label>
                    <input id="rp-retry" className="input" type="date" value={retryOn} onChange={(e) => setRetryOn(e.target.value)} />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="field">
              <label className="label" htmlFor="rp-pack">Pack</label>
              <select id="rp-pack" className="select" value={packId} onChange={(e) => setPackId(e.target.value)}>
                {packs.map((p) => <option key={p.id} value={p.id}>{p.label} · ₹{p.priceInr.toLocaleString("en-IN")}</option>)}
              </select>
            </div>
          )}
          <div className="grid-2" style={{ gap: 10 }}>
            <div className="field">
              <label className="label" htmlFor="rp-method">Method</label>
              <select id="rp-method" className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="rp-ref">Reference, optional</label>
              <input id="rp-ref" className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UPI or bank reference" />
            </div>
            <div className="field">
              <label className="label" htmlFor="rp-date">Paid on, if not today</label>
              <input id="rp-date" className="input" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </div>
          </div>
          <ReasonField value={reason} onChange={setReason} label="Note, optional" placeholder="Anything the next person should know" />
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={busy || !wsId}>{busy ? "Recording…" : "Record payment"}</button>
          </div>
        </Dialog>
      )}
      {toast.node}
    </>
  );
}

export function PaymentMenu({
  payment,
  canRefund,
  canRecord,
  grounds,
}: {
  payment: { id: string; kind: string; status: string; description: string; amount: string };
  canRefund: boolean;
  canRecord: boolean;
  grounds: { key: string; label: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = useState<"refund" | "retry" | null>(null);
  const [ground, setGround] = useState(grounds[0]?.key ?? "");
  const [retryOn, setRetryOn] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refundable = canRefund && payment.status === "captured" && (payment.kind === "subscription" || payment.kind === "top_up");
  const retryable = canRecord && (payment.status === "failed" || payment.status === "scheduled_retry");
  if (!refundable && !retryable) return <div />;

  async function call(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>(path, body);
      setDialog(null);
      toast.show(res.message);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ActionMenu label={`Actions for ${payment.description}`}>
        {refundable && <button onClick={() => setDialog("refund")}>Refund</button>}
        {retryable && <button onClick={() => setDialog("retry")}>Change retry date</button>}
      </ActionMenu>
      {dialog === "refund" && (
        <Dialog title={`Refund ${payment.amount}`} onClose={() => setDialog(null)} busy={busy}>
          <div className="dialog-body">
            For {payment.description}. Refunds follow the published refund policy: pick the ground it falls under. The invoice is
            voided, and a refunded pack takes its minutes back.
          </div>
          <div className="field">
            <label className="label" htmlFor="ground">Ground</label>
            <select id="ground" className="select" value={ground} onChange={(e) => setGround(e.target.value)}>
              {grounds.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select>
          </div>
          <ReasonField value={reason} onChange={setReason} />
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-danger-solid" onClick={() => call(`/api/payments/${payment.id}/refund`, { ground, reason })} disabled={busy}>Refund</button>
          </div>
        </Dialog>
      )}
      {dialog === "retry" && (
        <Dialog title="Next retry" onClose={() => setDialog(null)} busy={busy}>
          <div className="field">
            <label className="label" htmlFor="retry">Retry on</label>
            <input id="retry" className="input" type="date" value={retryOn} onChange={(e) => setRetryOn(e.target.value)} />
            <span className="hint">Leave blank to clear the retry.</span>
          </div>
          <ReasonField value={reason} onChange={setReason} />
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={() => call(`/api/payments/${payment.id}/retry`, { retryOn: retryOn || null, reason })} disabled={busy}>Save</button>
          </div>
        </Dialog>
      )}
      {toast.node}
    </>
  );
}
