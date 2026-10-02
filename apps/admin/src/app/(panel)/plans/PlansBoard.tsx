"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { ActionMenu, Dialog, useToast } from "@/components/ui";

/** Copy strings, verbatim from the build request. */
const PUBLISH_CONFIRM = "Publish these prices? The website, the customer portal and Saarthi update together, and this is recorded.";
const SLASHED_RULE =
  "A slashed price shows struck through beside the sale price; the sale price is the only one ever charged or invoiced.";

type Fields = {
  priceInr: number;
  slashedPriceInr: number | null;
  minutes: number;
  screenings: number;
  jobLimit: number | null;
  visibility: "public" | "hidden";
};

type PlanCard = {
  key: string;
  name: string;
  version: number;
  live: Fields;
  draft: Fields | null;
  changes: string[];
  workspaces: number;
  mrr: number;
  grandfathered: number;
};

type Pack = { id: string; kind: "minutes" | "screenings"; quantity: number; priceInr: number; validityDays: number };

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const packName = (p: Pick<Pack, "kind" | "quantity">) => `${p.quantity.toLocaleString("en-IN")} ${p.kind === "minutes" ? "minutes" : "CV screenings"}`;

export function PlansBoard(props: {
  canEdit: boolean;
  canPublish: boolean;
  editRefusal: string;
  publishRefusal: string;
  lastPublished: string | null;
  pending: number;
  plans: PlanCard[];
  packs: (Pack & { draft: (Pack & { retireOnPublish: boolean }) | null })[];
  newPacks: (Pack & { retireOnPublish: boolean })[];
  trial: { minutes: number; days: number };
  trialDraft: { minutes: number; days: number } | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = [
    ...props.plans.filter((p) => p.draft).map((p) => `${p.name}: ${p.changes.join(", ")}`),
    ...props.packs.filter((p) => p.draft).map((p) => (p.draft!.retireOnPublish ? `${packName(p)} pack: off sale` : `${packName(p)} pack: ${packName(p.draft!)} at ${rupees(p.draft!.priceInr)}`)),
    ...props.newPacks.map((p) => `New pack: ${packName(p)} at ${rupees(p.priceInr)}`),
    ...(props.trialDraft ? [`Trial: ${props.trialDraft.minutes} minutes, ${props.trialDraft.days} days`] : []),
  ];

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>("/api/pricing/publish");
      setConfirm(false);
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
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Plans and pricing</h1>
          <p className="page-sub">One table of truth. The website, the customer portal and Saarthi all read what you publish here.</p>
        </div>
        <div style={{ textAlign: "right" }}>
          <button className="btn btn-primary" style={{ padding: "11px 20px" }} onClick={() => setConfirm(true)}
            disabled={!props.canPublish || props.pending === 0} title={props.canPublish ? undefined : props.publishRefusal}>
            Publish pricing
          </button>
          <div className="hint" style={{ marginTop: 5 }}>
            {props.pending > 0
              ? `${props.pending} ${props.pending === 1 ? "draft" : "drafts"} waiting · live everywhere${props.lastPublished ? ` since ${props.lastPublished}` : ""}`
              : `Live everywhere${props.lastPublished ? ` · last published ${props.lastPublished}` : ""}`}
          </div>
        </div>
      </div>

      {!props.canEdit && <div className="notice">{props.editRefusal}</div>}
      {props.canEdit && !props.canPublish && <div className="notice">{props.publishRefusal} Your edits are saved as drafts for an Owner to publish.</div>}

      <div className="grid-3">
        {props.plans.map((p) => (
          <PlanEditor key={p.key} plan={p} canEdit={props.canEdit} onSaved={(m) => { toast.show(m); router.refresh(); }} />
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: 16 }}>
        <PacksCard packs={props.packs} newPacks={props.newPacks} canEdit={props.canEdit} onSaved={(m) => { toast.show(m); router.refresh(); }} />
        <TrialCard trial={props.trial} draft={props.trialDraft} canEdit={props.canEdit} onSaved={(m) => { toast.show(m); router.refresh(); }} />
      </div>

      <div className="notice">
        Publishing updates the website pricing page, the portal&apos;s Subscription page and Saarthi&apos;s answers in one step, and
        records who published and when. Until then, edits stay as drafts marked in amber. {SLASHED_RULE} Leaving the field blank
        shows no strike through at all.
      </div>

      {confirm && (
        <Dialog title="Publish pricing" onClose={() => setConfirm(false)} busy={busy}>
          <div className="dialog-body">{PUBLISH_CONFIRM}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: "var(--ink-body)", display: "flex", flexDirection: "column", gap: 4 }}>
            {changes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <div className="hint">Existing customers keep their price; the change applies to new signups.</div>
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={publish} disabled={busy}>{busy ? "Publishing…" : "Publish"}</button>
          </div>
        </Dialog>
      )}
      {toast.node}
    </>
  );
}

function PlanEditor({ plan, canEdit, onSaved }: { plan: PlanCard; canEdit: boolean; onSaved: (m: string) => void }) {
  const start = plan.draft ?? plan.live;
  const [f, setF] = useState({
    priceInr: String(start.priceInr),
    slashedPriceInr: start.slashedPriceInr ? String(start.slashedPriceInr) : "",
    minutes: String(start.minutes),
    screenings: String(start.screenings),
    jobLimit: start.jobLimit === null ? "Unlimited" : String(start.jobLimit),
    visibility: start.visibility,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed: Fields = {
    priceInr: Number(f.priceInr.replace(/[^\d]/g, "")),
    slashedPriceInr: f.slashedPriceInr.trim() ? Number(f.slashedPriceInr.replace(/[^\d]/g, "")) : null,
    minutes: Number(f.minutes.replace(/[^\d]/g, "")),
    screenings: Number(f.screenings.replace(/[^\d]/g, "")),
    jobLimit: /^unl/i.test(f.jobLimit.trim()) || !f.jobLimit.trim() ? null : Number(f.jobLimit.replace(/[^\d]/g, "")),
    visibility: f.visibility,
  };
  const base = plan.draft ?? plan.live;
  const dirty = (Object.keys(parsed) as (keyof Fields)[]).some((k) => parsed[k] !== base[k]);
  const differsFromLive = (k: keyof Fields) => parsed[k] !== plan.live[k];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>(`/api/pricing/plans/${plan.key}`, parsed);
      onSaved(res.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    setBusy(true);
    try {
      const res = await api<{ message: string }>(`/api/pricing/plans/${plan.key}/discard`);
      onSaved(res.message);
      setF({
        priceInr: String(plan.live.priceInr),
        slashedPriceInr: plan.live.slashedPriceInr ? String(plan.live.slashedPriceInr) : "",
        minutes: String(plan.live.minutes),
        screenings: String(plan.live.screenings),
        jobLimit: plan.live.jobLimit === null ? "Unlimited" : String(plan.live.jobLimit),
        visibility: plan.live.visibility,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = (k: keyof typeof f, label: string, extra?: string) => (
    <div>
      <label className="label" htmlFor={`${plan.key}-${k}`}>{label}</label>
      <input
        id={`${plan.key}-${k}`}
        className={`input sm${differsFromLive(k as keyof Fields) ? " draft" : ""}${extra ?? ""}`}
        value={f[k] as string}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
        disabled={!canEdit}
        aria-label={`${plan.name} ${label.toLowerCase()}`}
        placeholder={k === "slashedPriceInr" ? "None" : undefined}
      />
    </div>
  );

  return (
    <div className="card card-pad" style={{ padding: "18px 20px" }}>
      <div className="card-row">
        <div className="grow card-title">{plan.name}</div>
        {plan.draft ? <span className="chip sm chip-amber">Edited, not published</span> : <span className="chip sm chip-green">Live</span>}
      </div>
      <div className="grid-2" style={{ gap: 9 }}>
        {input("priceInr", "Sale price per month")}
        {input("slashedPriceInr", "Slashed price, optional", parsed.slashedPriceInr ? " struck" : "")}
        {input("minutes", "Interview minutes")}
        {input("screenings", "CV screenings")}
        {input("jobLimit", "Open jobs")}
        <div>
          <label className="label" htmlFor={`${plan.key}-visibility`}>Visibility</label>
          <select id={`${plan.key}-visibility`} className={`select input sm${differsFromLive("visibility") ? " draft" : ""}`} value={f.visibility}
            onChange={(e) => setF({ ...f, visibility: e.target.value as "public" | "hidden" })} disabled={!canEdit}>
            <option value="public">On sale</option>
            <option value="hidden">Hidden</option>
          </select>
        </div>
      </div>
      {plan.draft ? (
        <div style={{ fontSize: 12.5, color: "var(--amber-ink)" }}>
          Draft change: {plan.changes.join(", ")}. Existing customers keep their price; the change applies to new signups.
        </div>
      ) : (
        <div className="cell-muted">
          {plan.workspaces} {plan.workspaces === 1 ? "workspace" : "workspaces"} on this plan · {rupees(plan.mrr)} MRR
          {plan.grandfathered ? ` · ${plan.grandfathered} on an earlier price` : ""}
        </div>
      )}
      {error && <div className="error-text" role="alert">{error}</div>}
      {canEdit && (dirty || plan.draft) && (
        <div className="card-row">
          {dirty && <button className="btn sm btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save draft"}</button>}
          {plan.draft && <button className="btn sm" onClick={discard} disabled={busy}>Discard draft</button>}
        </div>
      )}
    </div>
  );
}

function PacksCard({
  packs,
  newPacks,
  canEdit,
  onSaved,
}: {
  packs: (Pack & { draft: (Pack & { retireOnPublish: boolean }) | null })[];
  newPacks: (Pack & { retireOnPublish: boolean })[];
  canEdit: boolean;
  onSaved: (m: string) => void;
}) {
  const [editing, setEditing] = useState<{ replacesId: string | null; pack: Partial<Pack> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>(path, body);
      setEditing(null);
      onSaved(res.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad" style={{ gap: 8 }}>
      <div className="card-row">
        <div className="grow card-title">Top up packs</div>
        {canEdit && (
          <button className="btn sm" onClick={() => setEditing({ replacesId: null, pack: { kind: "minutes", quantity: 100, priceInr: 2999, validityDays: 90 } })}>
            Add a pack
          </button>
        )}
      </div>
      {packs.map((p) => (
        <div key={p.id} className="card-row" style={{ fontSize: 13.5, padding: "8px 0", borderTop: "1px solid var(--line-soft)" }}>
          <span className="grow">
            <span className="cell-strong">{packName(p)}</span> · valid {p.validityDays} days
            {p.draft && (
              <span style={{ color: "var(--amber-ink)" }}>
                {" "}· draft: {p.draft.retireOnPublish ? "off sale" : `${packName(p.draft)}, ${rupees(p.draft.priceInr)}, ${p.draft.validityDays} days`}
              </span>
            )}
          </span>
          <span style={{ fontWeight: 600 }}>{rupees(p.priceInr)}</span>
          {p.draft ? <span className="chip sm chip-amber">Draft</span> : <span className="chip sm chip-green">Live</span>}
          {canEdit && (
            <ActionMenu label={`Actions for ${packName(p)}`}>
              <button onClick={() => setEditing({ replacesId: p.id, pack: { ...p } })}>Edit</button>
              <button className="danger" onClick={() => call(`/api/pricing/packs/${p.id}/retire`)}>Take off sale</button>
              {p.draft && <button onClick={() => call(`/api/pricing/packs/${p.draft!.id}/discard`)}>Discard draft</button>}
            </ActionMenu>
          )}
        </div>
      ))}
      {newPacks.map((p) => (
        <div key={p.id} className="card-row" style={{ fontSize: 13.5, padding: "8px 0", borderTop: "1px solid var(--line-soft)", color: "var(--amber-ink)" }}>
          <span className="grow"><b>{packName(p)}</b> · valid {p.validityDays} days · new</span>
          <span style={{ fontWeight: 600 }}>{rupees(p.priceInr)}</span>
          <span className="chip sm chip-amber">Draft</span>
          {canEdit && (
            <ActionMenu label={`Actions for draft ${packName(p)}`}>
              <button onClick={() => call(`/api/pricing/packs/${p.id}/discard`)}>Discard draft</button>
            </ActionMenu>
          )}
        </div>
      ))}
      {packs.length === 0 && newPacks.length === 0 && <div className="hint">No packs on sale.</div>}
      {error && !editing && <div className="error-text">{error}</div>}

      {editing && (
        <Dialog title={editing.replacesId ? "Change a pack" : "Add a pack"} onClose={() => setEditing(null)} busy={busy}>
          <div className="grid-2" style={{ gap: 10 }}>
            <div className="field">
              <label className="label" htmlFor="pk-kind">Pack of</label>
              <select id="pk-kind" className="select" value={editing.pack.kind}
                onChange={(e) => setEditing({ ...editing, pack: { ...editing.pack, kind: e.target.value as Pack["kind"] } })}>
                <option value="minutes">Interview minutes</option>
                <option value="screenings">CV screenings</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="pk-qty">How many</label>
              <input id="pk-qty" className="input" inputMode="numeric" value={editing.pack.quantity ?? ""}
                onChange={(e) => setEditing({ ...editing, pack: { ...editing.pack, quantity: Number(e.target.value.replace(/\D/g, "")) } })} />
            </div>
            <div className="field">
              <label className="label" htmlFor="pk-price">Price, rupees before GST</label>
              <input id="pk-price" className="input" inputMode="numeric" value={editing.pack.priceInr ?? ""}
                onChange={(e) => setEditing({ ...editing, pack: { ...editing.pack, priceInr: Number(e.target.value.replace(/\D/g, "")) } })} />
            </div>
            <div className="field">
              <label className="label" htmlFor="pk-days">Valid for, days</label>
              <input id="pk-days" className="input" inputMode="numeric" value={editing.pack.validityDays ?? ""}
                onChange={(e) => setEditing({ ...editing, pack: { ...editing.pack, validityDays: Number(e.target.value.replace(/\D/g, "")) } })} />
            </div>
          </div>
          <div className="hint">Saved as a draft. It goes on sale with the next publish.</div>
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}
              onClick={() => call("/api/pricing/packs", { ...editing.pack, replacesId: editing.replacesId })}>
              Save draft
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function TrialCard({
  trial,
  draft,
  canEdit,
  onSaved,
}: {
  trial: { minutes: number; days: number };
  draft: { minutes: number; days: number } | null;
  canEdit: boolean;
  onSaved: (m: string) => void;
}) {
  const start = draft ?? trial;
  const [minutes, setMinutes] = useState(String(start.minutes));
  const [days, setDays] = useState(String(start.days));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = Number(minutes) !== start.minutes || Number(days) !== start.days;

  async function call(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>(path, body);
      onSaved(res.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad">
      <div className="card-row">
        <div className="grow card-title">Trial</div>
        {draft ? <span className="chip sm chip-amber">Edited, not published</span> : <span className="chip sm chip-green">Live</span>}
      </div>
      <div className="grid-2" style={{ gap: 9 }}>
        <div>
          <label className="label" htmlFor="trial-min">Minutes</label>
          <input id="trial-min" className={`input sm${Number(minutes) !== trial.minutes ? " draft" : ""}`} value={minutes}
            onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} disabled={!canEdit} aria-label="Trial minutes" />
        </div>
        <div>
          <label className="label" htmlFor="trial-days">Days</label>
          <input id="trial-days" className={`input sm${Number(days) !== trial.days ? " draft" : ""}`} value={days}
            onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} disabled={!canEdit} aria-label="Trial days" />
        </div>
      </div>
      <div className="cell-muted">No card needed to start. Minutes apply to every workspace on trial once published; days to new signups.</div>
      {error && <div className="error-text">{error}</div>}
      {canEdit && (dirty || draft) && (
        <div className="card-row">
          {dirty && <button className="btn sm btn-primary" disabled={busy} onClick={() => call("/api/pricing/trial", { minutes: Number(minutes), days: Number(days) })}>Save draft</button>}
          {draft && <button className="btn sm" disabled={busy} onClick={() => call("/api/pricing/trial/discard")}>Discard draft</button>}
        </div>
      )}
    </div>
  );
}
