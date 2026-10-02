"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import type { PanelContext } from "@/lib/panel-context";
import { ActionMenu, Dialog, ReasonField, useToast } from "@/components/ui";
import { WorkspaceDialogs, type WorkspaceDialog, type WorkspaceRef } from "@/components/WorkspaceActions";

/** Copy string, verbatim from the build request. */
const DELETE_COPY =
  "Deleting removes every job, candidate, call and report after a 30 day hold in which it can still be restored. Type the workspace name to confirm. A second admin must approve.";

export function WorkspaceHeader({
  ws,
  ctx,
  chip,
}: {
  ws: WorkspaceRef;
  ctx: PanelContext;
  chip: { label: string; tone: string };
}) {
  const [dialog, setDialog] = useState<WorkspaceDialog>(null);
  const suspended = ws.status === "suspended";
  const closed = ws.status === "deleted_pending";
  return (
    <div className="card-row" style={{ gap: 12 }}>
      <h1 className="page-title">{ws.name}</h1>
      <span className={`chip chip-${chip.tone}`} style={{ padding: "4px 10px" }}>{chip.label}</span>
      <div className="grow" />
      {!closed && (
        <button className="btn" onClick={() => setDialog("signin")} disabled={!ctx.allowed["workspace.sign_in_as"] || suspended}
          title={suspended ? "A suspended workspace cannot be signed in to. Resume it first." : undefined}>
          Sign in as workspace
        </button>
      )}
      {!closed && ctx.allowed["workspace.suspend"] && (
        <button className="btn" onClick={() => setDialog(suspended ? "resume" : "suspend")}>{suspended ? "Resume" : "Suspend"}</button>
      )}
      <WorkspaceDialogs ws={ws} ctx={ctx} dialog={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

export function SubscriptionActions({ ws, ctx, summary }: { ws: WorkspaceRef; ctx: PanelContext; summary: string }) {
  const [dialog, setDialog] = useState<WorkspaceDialog>(null);
  const closed = ws.status === "deleted_pending";
  const canMinutes = ctx.allowed["workspace.grant_goodwill"] || ctx.allowed["workspace.add_pack"];
  return (
    <>
      <div className="card-row">
        <input type="text" className="input grow" value={summary} readOnly aria-label="Plan" />
        <button className="btn md" onClick={() => setDialog("plan")} disabled={closed || !ctx.allowed["workspace.change_plan"]}
          title={ctx.allowed["workspace.change_plan"] ? undefined : "Only an Owner or Engineer can change a plan."}>
          Change plan
        </button>
      </div>
      <div className="card-row">
        <button className="btn md btn-primary" onClick={() => setDialog("minutes")} disabled={closed || !canMinutes}>Add minutes</button>
        <span className="hint" style={{ fontSize: 12.5 }}>A top up pack or a goodwill grant, both logged with a reason.</span>
      </div>
      <WorkspaceDialogs ws={ws} ctx={ctx} dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

export function MemberMenu({
  wsId,
  member,
}: {
  wsId: string;
  member: { id: string; email: string; name: string | null; role: string; joined: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const [action, setAction] = useState<"reset" | "remove" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>(`/api/workspaces/${wsId}/members/${member.id}/${action}`, { reason });
      setAction(null);
      setReason("");
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
      <ActionMenu label={`Actions for ${member.email}`}>
        {member.joined && <button onClick={() => setAction("reset")}>Send password reset link</button>}
        {member.role !== "owner" ? (
          <button className="danger" onClick={() => setAction("remove")}>Remove from workspace</button>
        ) : (
          <div className="menu-note">The owner cannot be removed here.</div>
        )}
      </ActionMenu>
      {action && (
        <Dialog title={action === "reset" ? `Send a reset link to ${member.email}` : `Remove ${member.email}`} onClose={() => setAction(null)} busy={busy}>
          <div className="dialog-body">
            {action === "reset"
              ? "They get a one-time link to choose a new password. The workspace owner is emailed that it happened."
              : "They lose access straight away and their login is deleted. Jobs, notes and approvals they made stay. The workspace owner is emailed that it happened."}
          </div>
          <ReasonField value={reason} onChange={setReason} />
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setAction(null)} disabled={busy}>Cancel</button>
            <button className={`btn ${action === "remove" ? "btn-danger-solid" : "btn-primary"}`} onClick={submit} disabled={busy}>
              {busy ? "Working…" : action === "reset" ? "Send link" : "Remove member"}
            </button>
          </div>
        </Dialog>
      )}
      {toast.node}
    </>
  );
}

export function DeleteCard({
  ws,
  ctx,
  me,
  status,
  request,
  holdUntil,
}: {
  ws: WorkspaceRef;
  ctx: PanelContext;
  me: string;
  status: string;
  request: { by: string; byId: string; at: string | null } | null;
  holdUntil: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<"request" | "confirm" | "withdraw" | "restore" | null>(null);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canApprove = ctx.role === "owner" || ctx.role === "engineer";

  async function submit() {
    setBusy(true);
    setError(null);
    const path =
      mode === "request" ? "delete" : mode === "confirm" ? "delete/confirm" : mode === "withdraw" ? "delete/withdraw" : "restore";
    try {
      const res = await api<{ message: string }>(`/api/workspaces/${ws.id}/${path}`, { typedName: typed, reason });
      setMode(null);
      setTyped("");
      setReason("");
      toast.show(res.message);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (status === "deleted_pending") {
    body = (
      <>
        <div className="grow">
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--red)" }}>Held for deletion until {holdUntil}</div>
          <div className="cell-muted" style={{ marginTop: 3 }}>
            Members cannot sign in and nothing runs. Restore returns it exactly as it was; after the hold every job,
            candidate, call and report is erased. Invoices and payments are kept.
          </div>
        </div>
        {ctx.allowed["workspace.delete"] && <button className="btn md btn-primary" onClick={() => setMode("restore")}>Restore</button>}
      </>
    );
  } else if (request) {
    const mine = request.byId === me;
    body = (
      <>
        <div className="grow">
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--red)" }}>Deletion requested by {request.by}</div>
          <div className="cell-muted" style={{ marginTop: 3 }}>
            {mine
              ? "Waiting for a second admin to approve. You cannot approve your own request."
              : "A second admin must approve before the 30 day hold starts. Approving needs the workspace name typed again."}
          </div>
        </div>
        {(mine || ctx.allowed["workspace.delete"]) && <button className="btn md" onClick={() => setMode("withdraw")}>Withdraw</button>}
        {!mine && canApprove && <button className="btn md btn-danger" onClick={() => setMode("confirm")}>Approve deletion</button>}
      </>
    );
  } else {
    body = (
      <>
        <div className="grow">
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--red)" }}>Delete this workspace</div>
          <div className="cell-muted" style={{ marginTop: 3 }}>
            Removes every job, candidate, call and report after a 30 day hold in which it can still be restored. Requires
            typing the workspace name, and a second admin&apos;s confirmation. Every deletion is logged forever.
          </div>
        </div>
        <button className="btn md btn-danger" onClick={() => setMode("request")} disabled={!ctx.allowed["workspace.delete"]}
          title={ctx.allowed["workspace.delete"] ? undefined : "Only an Owner can delete a workspace."}>
          Delete workspace
        </button>
      </>
    );
  }

  const needsName = mode === "request" || mode === "confirm";
  const title =
    mode === "request" ? `Delete ${ws.name}` : mode === "confirm" ? `Approve deleting ${ws.name}` : mode === "withdraw" ? "Withdraw the deletion request" : `Restore ${ws.name}`;

  return (
    <div className="card card-danger" style={{ padding: "16px 22px", display: "flex", alignItems: "center", gap: 14 }}>
      {body}
      {mode && (
        <Dialog title={title} onClose={() => setMode(null)} busy={busy}>
          {needsName && <div className="dialog-body">{DELETE_COPY}</div>}
          {needsName && (
            <div className="field">
              <label className="label" htmlFor="typed">Workspace name</label>
              <input id="typed" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={ws.name} autoComplete="off" />
            </div>
          )}
          <ReasonField value={reason} onChange={setReason} />
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setMode(null)} disabled={busy}>Cancel</button>
            <button className={`btn ${needsName ? "btn-danger-solid" : "btn-primary"}`} onClick={submit}
              disabled={busy || (needsName && typed.trim() !== ws.name.trim())}>
              {busy ? "Working…" : mode === "request" ? "Ask a second admin" : mode === "confirm" ? "Approve, start the hold" : mode === "withdraw" ? "Withdraw" : "Restore"}
            </button>
          </div>
        </Dialog>
      )}
      {toast.node}
    </div>
  );
}
