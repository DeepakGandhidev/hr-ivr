"use client";

import { useState } from "react";
import { ActionMenu, useToast } from "@/components/ui";
import { EditDialog } from "@/components/WorkspaceEditKit";

export interface MailboxRow {
  id: string;
  provider: "gmail" | "outlook" | "imap" | "forward_alias";
  address: string;
  status: "connected" | "error" | "revoked";
  lastPollAt: string | null;
  errorDetail: string | null;
  folder: string;
  defaultJobId: string | null;
  autoRoute: boolean;
}

const PROVIDER: Record<MailboxRow["provider"], string> = { gmail: "Gmail", outlook: "Outlook", imap: "IMAP", forward_alias: "Forwarding" };
const STATUS_CHIP: Record<MailboxRow["status"], { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "green" },
  error: { label: "Failing", tone: "red" },
  revoked: { label: "Paused", tone: "neutral" },
};

type Action = "pause" | "resume" | "route" | "disconnect";
const COLS = "minmax(0, 2fr) 100px 140px minmax(0, 1.4fr) 40px";

/**
 * The Mailboxes tab. Credentials never reach this page: the server reads
 * mailboxes through an allowlist with no secret, token or forwarding address.
 */
export function WorkspaceMailboxes({
  wsId,
  mailboxes,
  jobs,
  canEdit,
}: {
  wsId: string;
  mailboxes: (MailboxRow & { lastChecked: string })[];
  jobs: { id: string; title: string; status: string }[];
  canEdit: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState<{ action: Action; box: MailboxRow } | null>(null);
  const done = (msg: string) => {
    setOpen(null);
    toast.show(msg);
  };
  const jobTitle = (id: string | null) => (id ? jobs.find((j) => j.id === id)?.title ?? "an archived job" : null);

  return (
    <>
      <div className="table">
        <div className="trow head" style={{ gridTemplateColumns: COLS }}>
          <span>Mailbox</span>
          <span>Status</span>
          <span>Last checked</span>
          <span>Files mail to</span>
          <span />
        </div>
        {mailboxes.length === 0 && <div className="empty"><strong>No mailboxes connected</strong>The customer connects one in the portal.</div>}
        {mailboxes.map((m) => {
          const chip = STATUS_CHIP[m.status];
          const dest = jobTitle(m.defaultJobId);
          return (
            <div key={m.id} className="trow" style={{ gridTemplateColumns: COLS, fontSize: 13.5 }}>
              <span style={{ minWidth: 0 }}>
                <span className="cell-strong">{m.address}</span>
                <div className="cell-sub">
                  {PROVIDER[m.provider]}{m.provider === "imap" ? ` · ${m.folder}` : ""}{m.errorDetail && m.status === "error" ? ` · ${m.errorDetail}` : ""}
                </div>
              </span>
              <span><span className={`chip chip-${chip.tone}`}>{chip.label}</span></span>
              <span className="cell-muted">{m.lastChecked}</span>
              <span style={{ minWidth: 0 }}>
                {m.autoRoute ? "Matched to each open job" : dest ?? <span className="cell-muted">Nowhere, idle</span>}
                {m.autoRoute && <div className="cell-sub">{dest ? `Otherwise ${dest}` : "Unmatched mail waits"}</div>}
              </span>
              {canEdit ? (
                <ActionMenu label={`Actions for ${m.address}`}>
                  <button onClick={() => setOpen({ action: "route", box: m })}>Change where mail goes</button>
                  {m.status === "revoked" ? (
                    <button onClick={() => setOpen({ action: "resume", box: m })}>Resume</button>
                  ) : (
                    <button onClick={() => setOpen({ action: "pause", box: m })}>Pause</button>
                  )}
                  <button className="danger" onClick={() => setOpen({ action: "disconnect", box: m })}>Disconnect</button>
                </ActionMenu>
              ) : <span />}
            </div>
          );
        })}
        <div className="tfoot">
          <span className="grow">Passwords and tokens are never shown here. Changing the server, folder or password is done in the portal.</span>
        </div>
      </div>
      {open?.action === "route" && <RouteDialog wsId={wsId} box={open.box} jobs={jobs} onClose={() => setOpen(null)} onDone={done} />}
      {(open?.action === "pause" || open?.action === "resume") && (
        <EditDialog title={`${open.action === "pause" ? "Pause" : "Resume"} ${open.box.address}`} path={`/api/workspaces/${wsId}/mailboxes/${open.box.id}`}
          confirm={open.action === "pause" ? "Pause mailbox" : "Resume mailbox"}
          payload={() => ({ status: open.action === "pause" ? "revoked" : "connected" })} onClose={() => setOpen(null)} onDone={done}>
          <div className="dialog-body">
            {open.action === "pause"
              ? "Pratibha stops reading this mailbox. Nothing is deleted, and Resume picks up from where it stopped."
              : "Pratibha reads this mailbox again from the next check. If its login has expired it shows as failing until the customer reconnects it."}
          </div>
        </EditDialog>
      )}
      {open?.action === "disconnect" && (
        <EditDialog title={`Disconnect ${open.box.address}`} path={`/api/workspaces/${wsId}/mailboxes/${open.box.id}/disconnect`}
          confirm="Disconnect" danger payload={() => ({})} onClose={() => setOpen(null)} onDone={done}>
          <div className="dialog-body">
            The connection and its saved login are removed for good; the customer must connect it again to use it. Candidates
            already filed from it stay. To stop it for a while, pause it instead.
          </div>
        </EditDialog>
      )}
      {toast.node}
    </>
  );
}

function RouteDialog({
  wsId,
  box,
  jobs,
  onClose,
  onDone,
}: {
  wsId: string;
  box: MailboxRow;
  jobs: { id: string; title: string; status: string }[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const known = jobs.some((j) => j.id === box.defaultJobId);
  const [jobId, setJobId] = useState(known ? box.defaultJobId ?? "" : "");
  const [autoRoute, setAutoRoute] = useState(box.autoRoute);
  const needsJob = box.provider === "forward_alias";

  return (
    <EditDialog title={`Where mail from ${box.address} goes`} path={`/api/workspaces/${wsId}/mailboxes/${box.id}`} confirm="Save"
      ready={!needsJob || Boolean(jobId)} payload={() => ({ defaultJobId: jobId || null, autoRoute })} onClose={onClose} onDone={onDone}>
      <div className="choice">
        <label className={!autoRoute ? "on" : ""}>
          <input type="radio" checked={!autoRoute} onChange={() => setAutoRoute(false)} />
          <b>One job</b>
          <span className="hint">Every application goes to the job below</span>
        </label>
        <label className={autoRoute ? "on" : ""}>
          <input type="radio" checked={autoRoute} onChange={() => setAutoRoute(true)} />
          <b>Match each one</b>
          <span className="hint">Each application goes to the open job it fits</span>
        </label>
      </div>
      <div className="field">
        <label className="label" htmlFor="mb-job">{autoRoute ? "When nothing matches" : "Job"}</label>
        <select id="mb-job" className="select" value={jobId} onChange={(e) => setJobId(e.target.value)}>
          {!needsJob && <option value="">{autoRoute ? "Leave it waiting" : "None, the mailbox sits idle"}</option>}
          {needsJob && !jobId && <option value="">Choose a job</option>}
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.title} · {j.status}</option>)}
        </select>
        {needsJob && <span className="hint">A forwarding address always needs a job, or the mail it receives is dropped.</span>}
      </div>
    </EditDialog>
  );
}
