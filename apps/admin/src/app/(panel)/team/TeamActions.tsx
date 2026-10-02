"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { ActionMenu, Dialog, ReasonField, useToast } from "@/components/ui";

const ROLES = [
  { value: "owner", label: "Owner" },
  { value: "engineer", label: "Engineer" },
  { value: "support", label: "Support" },
];

export function InviteAdminButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("support");
  const [link, setLink] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string; link: string | null }>("/api/team", { name, email, role });
      setMessage(res.message);
      setLink(res.link);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-primary" onClick={() => { setOpen(true); setMessage(null); setLink(null); }}>Invite an admin</button>
      {open && (
        <Dialog title="Invite an admin" onClose={() => setOpen(false)} busy={busy}>
          {message ? (
            <>
              <div className="dialog-body">{message}</div>
              {link && <div className="secret-box" style={{ fontSize: 13 }}>{link}</div>}
              <div className="dialog-actions"><button className="btn btn-primary" onClick={() => setOpen(false)}>Done</button></div>
            </>
          ) : (
            <>
              <div className="grid-2" style={{ gap: 10 }}>
                <div className="field">
                  <label className="label" htmlFor="ia-name">Name</label>
                  <input id="ia-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="field">
                  <label className="label" htmlFor="ia-email">Email</label>
                  <input id="ia-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label className="label" htmlFor="ia-role">Role</label>
                <select id="ia-role" className="select" value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div className="hint">They get a one-time link, valid 72 hours, to set a password; then they turn on two step verification.</div>
              {error && <div className="error-text" role="alert">{error}</div>}
              <div className="dialog-actions">
                <button className="btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
                <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? "Inviting…" : "Send invite"}</button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}

export function TeamMenu({
  target,
}: {
  target: { id: string; name: string; role: string; deactivated: boolean; twoStep: boolean; pending: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = useState<"role" | "deactivate" | "reactivate" | "reset_two_step" | null>(null);
  const [role, setRole] = useState(target.role);
  const [reason, setReason] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string; link?: string | null }>(`/api/team/${target.id}`, body);
      if (res.link) {
        setLink(res.link);
      } else {
        setDialog(null);
      }
      toast.show(res.message);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      toast.show((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const titles = {
    role: `Change ${target.name}'s role`,
    deactivate: `Deactivate ${target.name}`,
    reactivate: `Reactivate ${target.name}`,
    reset_two_step: `Reset two step for ${target.name}`,
  };

  return (
    <>
      <ActionMenu label={`Actions for ${target.name}`}>
        {!target.deactivated && <button onClick={() => setDialog("role")}>Change role</button>}
        {target.pending && <button onClick={() => call({ action: "resend_invite" })}>Send a new invite</button>}
        {target.twoStep && <button onClick={() => setDialog("reset_two_step")}>Reset two step</button>}
        {target.deactivated
          ? <button onClick={() => setDialog("reactivate")}>Reactivate</button>
          : <button className="danger" onClick={() => setDialog("deactivate")}>Deactivate</button>}
      </ActionMenu>
      {link && (
        <Dialog title="One-time invite link" onClose={() => setLink(null)}>
          <div className="dialog-body">Email is not configured, so share this link with {target.name} yourself. It works once, for 72 hours.</div>
          <div className="secret-box" style={{ fontSize: 13 }}>{link}</div>
          <div className="dialog-actions"><button className="btn btn-primary" onClick={() => setLink(null)}>Done</button></div>
        </Dialog>
      )}
      {dialog && (
        <Dialog title={titles[dialog]} onClose={() => setDialog(null)} busy={busy}>
          {dialog === "role" && (
            <div className="field">
              <label className="label" htmlFor="role">Role</label>
              <select id="role" className="select" value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          )}
          {dialog === "deactivate" && <div className="dialog-body">They are signed out everywhere at once and cannot sign in again until reactivated.</div>}
          {dialog === "reset_two_step" && <div className="dialog-body">For a lost phone. They are signed out and set up two step again at their next sign in.</div>}
          <ReasonField value={reason} onChange={setReason} />
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
            <button className={`btn ${dialog === "deactivate" ? "btn-danger-solid" : "btn-primary"}`} disabled={busy}
              onClick={() => call(dialog === "role" ? { action: "role", role, reason } : { action: dialog, reason })}>
              {busy ? "Saving…" : "Confirm"}
            </button>
          </div>
        </Dialog>
      )}
      {toast.node}
    </>
  );
}
