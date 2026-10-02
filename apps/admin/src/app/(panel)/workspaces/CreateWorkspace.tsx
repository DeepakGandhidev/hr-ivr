"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { Dialog, ReasonField } from "@/components/ui";
import type { PanelContext } from "@/lib/panel-context";

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function CreateWorkspaceButton({ plans }: { plans: PanelContext["plans"] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [planKey, setPlanKey] = useState("trial");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ id: string; message: string }>("/api/workspaces", {
        name, slug, ownerName, ownerEmail, planKey, reason,
      });
      router.push(`/workspaces/${res.id}?created=1`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-primary" onClick={() => setOpen(true)}>Create workspace</button>
      {open && (
        <Dialog title="Create a workspace" onClose={() => setOpen(false)} busy={busy}>
          <div className="dialog-body">
            For a company you are onboarding by hand. The owner gets an email to choose their password.
          </div>
          <div className="grid-2" style={{ gap: 10 }}>
            <div className="field">
              <label className="label" htmlFor="ws-name">Company name</label>
              <input id="ws-name" className="input" value={name} onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }} />
            </div>
            <div className="field">
              <label className="label" htmlFor="ws-slug">Address, pratibha.tech/…</label>
              <input id="ws-slug" className="input" value={slug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }} />
            </div>
            <div className="field">
              <label className="label" htmlFor="ws-owner">Owner&apos;s name</label>
              <input id="ws-owner" className="input" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="ws-email">Owner&apos;s email</label>
              <input id="ws-email" className="input" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="ws-plan">Start on</label>
            <select id="ws-plan" className="select" value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
              <option value="trial">The trial</option>
              {plans.map((p) => (
                <option key={p.key} value={p.key}>{p.name} · ₹{p.priceInr.toLocaleString("en-IN")} a month</option>
              ))}
            </select>
          </div>
          <ReasonField value={reason} onChange={setReason} />
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create workspace"}</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
