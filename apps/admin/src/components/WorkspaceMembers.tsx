"use client";

import { useState } from "react";
import { ActionMenu, useToast } from "@/components/ui";
import { EditDialog } from "@/components/WorkspaceEditKit";

export interface MemberRow {
  id: string;
  name: string | null;
  email: string;
  role: "owner" | "admin" | "reviewer" | "viewer";
  joined: boolean;
  createdAt: string;
}

const ROLE_LABEL: Record<MemberRow["role"], string> = { owner: "Owner", admin: "Admin", reviewer: "Reviewer", viewer: "Viewer" };

/** What each role can do in the portal, so the admin picks knowingly. */
const ROLE_HINT: Record<Exclude<MemberRow["role"], "owner">, string> = {
  admin: "Jobs, candidates, mailboxes and settings. Not the team or billing.",
  reviewer: "Reviews and shortlists candidates; cannot change jobs or settings.",
  viewer: "Reads everything, changes nothing.",
};

type Action = "role" | "owner" | "invite" | "reset" | "remove";

/** The Members tab: every member, with role changes, ownership, invites, resets and removal. */
export function WorkspaceMembers({ wsId, members, canEdit }: { wsId: string; members: MemberRow[]; canEdit: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState<{ action: Action; member: MemberRow } | null>(null);
  const done = (msg: string) => {
    setOpen(null);
    toast.show(msg);
  };

  return (
    <>
      <div className="table">
        <div className="trow head" style={{ gridTemplateColumns: "minmax(0, 2fr) 110px 150px 120px 40px" }}>
          <span>Member</span>
          <span>Role</span>
          <span>Login</span>
          <span>Added</span>
          <span />
        </div>
        {members.map((m) => (
          <div key={m.id} className="trow" style={{ gridTemplateColumns: "minmax(0, 2fr) 110px 150px 120px 40px", fontSize: 13.5 }}>
            <span style={{ minWidth: 0 }}>
              <span className="cell-strong">{m.name ?? m.email.split("@")[0]}</span>
              <div className="cell-sub">{m.email}</div>
            </span>
            <span><span className={`chip ${m.role === "owner" ? "chip-indigo" : "chip-neutral"}`}>{ROLE_LABEL[m.role]}</span></span>
            <span className={m.joined ? undefined : "cell-muted"}>{m.joined ? "Joined" : "Invited, not joined"}</span>
            <span className="cell-muted">{m.createdAt}</span>
            {canEdit ? (
              <ActionMenu label={`Actions for ${m.email}`}>
                {m.role !== "owner" && <button onClick={() => setOpen({ action: "role", member: m })}>Change role</button>}
                {m.role !== "owner" && (
                  m.joined
                    ? <button onClick={() => setOpen({ action: "owner", member: m })}>Make owner</button>
                    : <div className="menu-note">Ownership goes to someone who has joined.</div>
                )}
                {!m.joined && <button onClick={() => setOpen({ action: "invite", member: m })}>Send invite</button>}
                {m.joined && <button onClick={() => setOpen({ action: "reset", member: m })}>Send password reset link</button>}
                {m.role !== "owner" ? (
                  <button className="danger" onClick={() => setOpen({ action: "remove", member: m })}>Remove from workspace</button>
                ) : (
                  <div className="menu-note">The owner cannot be removed. Make someone else the owner first.</div>
                )}
              </ActionMenu>
            ) : <span />}
          </div>
        ))}
        <div className="tfoot">
          <span className="grow">
            A workspace has exactly one owner. Every change here is logged with its reason, and the owner is emailed.
          </span>
        </div>
      </div>
      {open && <MemberDialog wsId={wsId} action={open.action} member={open.member} onClose={() => setOpen(null)} onDone={done} />}
      {toast.node}
    </>
  );
}

function MemberDialog({
  wsId,
  action,
  member,
  onClose,
  onDone,
}: {
  wsId: string;
  action: Action;
  member: MemberRow;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const roles = (["admin", "reviewer", "viewer"] as const).filter((r) => r !== member.role);
  const [role, setRole] = useState<string>(roles[0]);
  const path = `/api/workspaces/${wsId}/members/${member.id}/${action}`;
  const common = { path, onClose, onDone };

  switch (action) {
    case "role":
      return (
        <EditDialog {...common} title={`Change ${member.email}'s role`} confirm="Change role" payload={() => ({ role })}>
          <div className="dialog-body">Now {ROLE_LABEL[member.role]}. The change applies on their next screen load.</div>
          <div className="choice" style={{ flexDirection: "column" }}>
            {roles.map((r) => (
              <label key={r} className={role === r ? "on" : ""}>
                <input type="radio" checked={role === r} onChange={() => setRole(r)} />
                <b>{ROLE_LABEL[r]}</b>
                <span className="hint">{ROLE_HINT[r]}</span>
              </label>
            ))}
          </div>
        </EditDialog>
      );
    case "owner":
      return (
        <EditDialog {...common} title={`Make ${member.email} the owner`} confirm="Transfer ownership" payload={() => ({})}>
          <div className="dialog-body">
            They take over the team and billing. The current owner stays in the workspace as an Admin. Both are emailed.
          </div>
        </EditDialog>
      );
    case "invite":
      return (
        <EditDialog {...common} title={`Invite ${member.email}`} confirm="Send invite" payload={() => ({})}>
          <div className="dialog-body">
            They get a portal login and an email with a one-time link to choose a password, valid for an hour. They join as{" "}
            {ROLE_LABEL[member.role]}.
          </div>
        </EditDialog>
      );
    case "reset":
      return (
        <EditDialog {...common} title={`Send a reset link to ${member.email}`} confirm="Send link" payload={() => ({})}>
          <div className="dialog-body">They get a one-time link to choose a new password. The workspace owner is emailed that it happened.</div>
        </EditDialog>
      );
    case "remove":
      return (
        <EditDialog {...common} title={`Remove ${member.email}`} confirm="Remove member" danger payload={() => ({})}>
          <div className="dialog-body">
            They lose access straight away and their login is deleted. Jobs, notes and approvals they made stay. The workspace
            owner is emailed that it happened.
          </div>
        </EditDialog>
      );
  }
}
