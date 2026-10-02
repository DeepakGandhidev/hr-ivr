"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { ActionMenu, Dialog, useToast } from "@/components/ui";

export function CreateCouponButton({ plans }: { plans: { key: string; name: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: "", kind: "percent" as "percent" | "amount", value: "", cap: "", startsAt: "", expiresAt: "", plans: [] as string[] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(draft: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>("/api/coupons", {
        code: f.code,
        kind: f.kind,
        value: Number(f.value),
        applicablePlans: f.plans,
        cap: f.cap ? Number(f.cap) : null,
        startsAt: f.startsAt || null,
        expiresAt: f.expiresAt || null,
        draft,
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
      <button className="btn btn-primary" onClick={() => setOpen(true)}>Create coupon</button>
      {open && (
        <Dialog title="Create a coupon" onClose={() => setOpen(false)} busy={busy}>
          <div className="grid-2" style={{ gap: 10 }}>
            <div className="field">
              <label className="label" htmlFor="c-code">Code</label>
              <input id="c-code" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} placeholder="DIWALI26" />
            </div>
            <div className="field">
              <label className="label" htmlFor="c-kind">Discount</label>
              <div style={{ display: "flex", gap: 6 }}>
                <select id="c-kind" className="select" style={{ width: 120 }} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "percent" | "amount" })}>
                  <option value="percent">Percent</option>
                  <option value="amount">Flat ₹</option>
                </select>
                <input className="input" inputMode="numeric" aria-label="Discount value" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value.replace(/\D/g, "") })} placeholder={f.kind === "percent" ? "20" : "2000"} />
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="c-start">Starts, optional</label>
              <input id="c-start" className="input" type="date" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
            </div>
            <div className="field">
              <label className="label" htmlFor="c-exp">Expires, optional</label>
              <input id="c-exp" className="input" type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} />
            </div>
            <div className="field">
              <label className="label" htmlFor="c-cap">Redemption cap, optional</label>
              <input id="c-cap" className="input" inputMode="numeric" value={f.cap} onChange={(e) => setF({ ...f, cap: e.target.value.replace(/\D/g, "") })} placeholder="No cap" />
            </div>
            <div className="field">
              <span className="label">Applies to</span>
              <div className="pills">
                {plans.map((p) => {
                  const on = f.plans.includes(p.key);
                  return (
                    <button key={p.key} type="button" className={`pill${on ? " on" : ""}`}
                      onClick={() => setF({ ...f, plans: on ? f.plans.filter((k) => k !== p.key) : [...f.plans, p.key] })}>
                      {p.name}
                    </button>
                  );
                })}
              </div>
              <span className="hint">{f.plans.length ? "Only the chosen plans." : "None chosen means every plan."}</span>
            </div>
          </div>
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
            <button className="btn" onClick={() => submit(true)} disabled={busy}>Save as draft</button>
            <button className="btn btn-primary" onClick={() => submit(false)} disabled={busy}>
              {f.startsAt && new Date(`${f.startsAt}T00:00:00+05:30`) > new Date() ? "Schedule" : "Create, active now"}
            </button>
          </div>
        </Dialog>
      )}
      {toast.node}
    </>
  );
}

export function CouponMenu({
  coupon,
}: {
  coupon: { id: string; code: string; status: string; cap: number | null; redeemed: number; expiresAt: string | null };
}) {
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = useState<"caps" | "end" | null>(null);
  const [cap, setCap] = useState(coupon.cap === null ? "" : String(coupon.cap));
  const [expiresAt, setExpiresAt] = useState(coupon.expiresAt ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      if (!dialog) toast.show((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ended = coupon.status === "ended";
  return (
    <>
      <ActionMenu label={`Actions for ${coupon.code}`}>
        {coupon.status === "draft" && <button onClick={() => call(`/api/coupons/${coupon.id}/state`, { to: "schedule" })}>Make live</button>}
        {(coupon.status === "active" || coupon.status === "scheduled") && (
          <button onClick={() => call(`/api/coupons/${coupon.id}/state`, { to: "pause" })}>Pause</button>
        )}
        {coupon.status === "paused" && <button onClick={() => call(`/api/coupons/${coupon.id}/state`, { to: "resume" })}>Resume</button>}
        {!ended && <button onClick={() => setDialog("caps")}>Edit caps</button>}
        <Link href={`/coupons/${coupon.id}`}>See redemptions</Link>
        {!ended && <button className="danger" onClick={() => setDialog("end")}>End now</button>}
      </ActionMenu>
      {dialog === "caps" && (
        <Dialog title={`Caps on ${coupon.code}`} onClose={() => setDialog(null)} busy={busy}>
          <div className="grid-2" style={{ gap: 10 }}>
            <div className="field">
              <label className="label" htmlFor="cap">Redemption cap</label>
              <input id="cap" className="input" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ""))} placeholder="No cap" />
              <span className="hint">Redeemed {coupon.redeemed} so far.</span>
            </div>
            <div className="field">
              <label className="label" htmlFor="exp">Expires</label>
              <input id="exp" className="input" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </div>
          </div>
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}
              onClick={() => call(`/api/coupons/${coupon.id}/caps`, { cap: cap ? Number(cap) : null, expiresAt: expiresAt || null })}>Save</button>
          </div>
        </Dialog>
      )}
      {dialog === "end" && (
        <Dialog title={`End ${coupon.code} now`} onClose={() => setDialog(null)} busy={busy}>
          <div className="dialog-body">The code stops working everywhere at once and can never be used again, nor reused for a new coupon.</div>
          <div className="field">
            <label className="label" htmlFor="end-reason">Reason, optional</label>
            <input id="end-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-danger-solid" disabled={busy} onClick={() => call(`/api/coupons/${coupon.id}/state`, { to: "end", reason: reason || undefined })}>End now</button>
          </div>
        </Dialog>
      )}
      {toast.node}
    </>
  );
}
