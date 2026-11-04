"use client";

import { useState } from "react";
import { useToast } from "@/components/ui";
import { EDIT_REFUSAL, EditDialog, Fact, TextField } from "@/components/WorkspaceEditKit";

interface Company {
  legalName: string;
  addressLine: string;
  city: string;
  pinCode: string;
  billingState: string;
  gstin: string;
  description: string;
}

/** The Workspace tab: name and address, then the company profile the portal's Company page edits. */
export function WorkspaceProfile({
  ws,
  company,
  states,
  limits,
  canEdit,
  portalBase,
}: {
  ws: { id: string; name: string; slug: string; createdAt: string };
  company: Company;
  states: string[];
  limits: { legalName: number; addressLine: number; city: number; description: number };
  canEdit: boolean;
  portalBase: string;
}) {
  const toast = useToast();
  const [dialog, setDialog] = useState<"details" | "company" | null>(null);
  const done = (msg: string) => {
    setDialog(null);
    toast.show(msg);
  };
  const editButton = (which: "details" | "company") => (
    <button className="btn sm" onClick={() => setDialog(which)} disabled={!canEdit} title={canEdit ? undefined : EDIT_REFUSAL}>Edit</button>
  );
  const dash = (v: string) => v || <span className="cell-muted">Not set</span>;

  return (
    <>
      <div className="grid-2">
        <div className="card card-pad">
          <div className="card-row">
            <div className="grow card-title">Workspace</div>
            {editButton("details")}
          </div>
          <Fact label="Name">{ws.name}</Fact>
          <Fact label="Address">{portalBase}/{ws.slug}</Fact>
          <Fact label="Created">{ws.createdAt}</Fact>
          <div className="card-foot">The name is what Pratibha says on calls unless the interview settings name a company.</div>
        </div>
        <div className="card card-pad">
          <div className="card-row">
            <div className="grow card-title">Company profile</div>
            {editButton("company")}
          </div>
          <Fact label="Legal name">{dash(company.legalName)}</Fact>
          <Fact label="Address">
            {[company.addressLine, [company.city, company.pinCode].filter(Boolean).join(" ")].filter(Boolean).join("\n") || dash("")}
          </Fact>
          <Fact label="State">{dash(company.billingState)}</Fact>
          <Fact label="GSTIN">{company.gstin ? <span className="mono">{company.gstin}</span> : dash("")}</Fact>
          <Fact label="Description">{dash(company.description)}</Fact>
          <div className="card-foot">Printed on GST invoices; the description shows on their careers page. The logo is changed in the portal.</div>
        </div>
      </div>
      {dialog === "details" && <DetailsDialog ws={ws} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "company" && (
        <CompanyDialog wsId={ws.id} company={company} states={states} limits={limits} onClose={() => setDialog(null)} onDone={done} />
      )}
      {toast.node}
    </>
  );
}

function DetailsDialog({
  ws,
  onClose,
  onDone,
}: {
  ws: { id: string; name: string; slug: string };
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [name, setName] = useState(ws.name);
  const [slug, setSlug] = useState(ws.slug);
  const moving = slug.trim().toLowerCase() !== ws.slug;
  return (
    <EditDialog title={`Edit ${ws.name}`} path={`/api/workspaces/${ws.id}/details`} confirm={moving ? "Save and move" : "Save"}
      payload={() => ({ name, slug })} onClose={onClose} onDone={onDone} ready={Boolean(name.trim() && slug.trim())}>
      <TextField id="ws-name" label="Workspace name" value={name} onChange={setName} max={120} />
      <TextField id="ws-slug" label="Address" value={slug} max={40}
        onChange={(v) => setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
        hint="Lowercase letters, numbers and hyphens, 3 to 40 characters." />
      {moving && (
        <div className="notice">
          The workspace moves from /{ws.slug} to /{slug.trim() || "…"}. Every bookmark, emailed link and shared careers page
          link to the old address stops working. Tell the owner before you save.
        </div>
      )}
    </EditDialog>
  );
}

function CompanyDialog({
  wsId,
  company,
  states,
  limits,
  onClose,
  onDone,
}: {
  wsId: string;
  company: Company;
  states: string[];
  limits: { legalName: number; addressLine: number; city: number; description: number };
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [form, setForm] = useState<Company>(company);
  const set = (key: keyof Company) => (v: string) => setForm((f) => ({ ...f, [key]: v }));
  return (
    <EditDialog title="Edit company profile" path={`/api/workspaces/${wsId}/company`} confirm="Save profile" width={600}
      payload={() => ({ ...form })} onClose={onClose} onDone={onDone}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: "48vh", overflowY: "auto", paddingRight: 4 }}>
        <TextField id="co-legal" label="Legal name" value={form.legalName} onChange={set("legalName")} max={limits.legalName}
          hint="Exactly as it should print on GST invoices." />
        <TextField id="co-address" label="Address line" value={form.addressLine} onChange={set("addressLine")} max={limits.addressLine} />
        <div className="grid-2" style={{ gap: 10 }}>
          <TextField id="co-city" label="City" value={form.city} onChange={set("city")} max={limits.city} />
          <TextField id="co-pin" label="PIN code" value={form.pinCode} onChange={(v) => set("pinCode")(v.replace(/\D/g, ""))} max={6} />
        </div>
        <div className="grid-2" style={{ gap: 10 }}>
          <div className="field">
            <label className="label" htmlFor="co-state">State</label>
            <select id="co-state" className="select" value={form.billingState} onChange={(e) => set("billingState")(e.target.value)}>
              <option value="">Not set</option>
              {states.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <span className="hint">Decides CGST + SGST or IGST.</span>
          </div>
          <TextField id="co-gstin" label="GSTIN" value={form.gstin} onChange={(v) => set("gstin")(v.toUpperCase())} max={15}
            hint="15 characters. Blank if not registered." />
        </div>
        <div className="field">
          <label className="label" htmlFor="co-desc">Description</label>
          <textarea id="co-desc" className="textarea" value={form.description} maxLength={limits.description}
            onChange={(e) => set("description")(e.target.value)} />
          <span className="hint">Shown on their careers page. {form.description.length} of {limits.description} characters.</span>
        </div>
      </div>
    </EditDialog>
  );
}
