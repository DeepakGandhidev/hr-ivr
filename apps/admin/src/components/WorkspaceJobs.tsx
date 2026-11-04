"use client";

import { useState } from "react";
import { ActionMenu, useToast } from "@/components/ui";
import { EditDialog, TextField } from "@/components/WorkspaceEditKit";
import { InterviewDialog, type InterviewRules } from "@/components/WorkspaceInterview";
import type { ProtocolForm } from "@/lib/workspace-edit-data";

export interface JobRow {
  id: string;
  title: string;
  status: "draft" | "open" | "paused" | "closed";
  screeningThreshold: number | null;
  candidates: number;
  approvedDescription: boolean;
  createdAt: string;
  archivedAt: string | null;
  override: ProtocolForm | null;
}

const STATUS_CHIP: Record<JobRow["status"], { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "neutral" },
  open: { label: "Open", tone: "green" },
  paused: { label: "Paused", tone: "amber" },
  closed: { label: "Closed", tone: "neutral" },
};

type Action = "edit" | "interview" | "default" | "archive" | "restore";
const COLS = "minmax(0, 2fr) 110px 100px 110px 130px 40px";

/** The Jobs tab: every job, archived ones last, with edits, interview overrides and archive or restore. */
export function WorkspaceJobs({
  wsId,
  jobs,
  workspaceProtocol,
  rules,
  defaultThreshold,
  jobLimit,
  canEdit,
}: {
  wsId: string;
  jobs: JobRow[];
  workspaceProtocol: ProtocolForm;
  rules: InterviewRules;
  defaultThreshold: number;
  jobLimit: number | null;
  canEdit: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState<{ action: Action; job: JobRow } | null>(null);
  const done = (msg: string) => {
    setOpen(null);
    toast.show(msg);
  };
  const active = jobs.filter((j) => !j.archivedAt && (j.status === "open" || j.status === "paused")).length;

  return (
    <>
      <div className="table">
        <div className="trow head" style={{ gridTemplateColumns: COLS }}>
          <span>Job</span>
          <span>Status</span>
          <span>Candidates</span>
          <span>Threshold</span>
          <span>Interview</span>
          <span />
        </div>
        {jobs.length === 0 && <div className="empty"><strong>No jobs yet</strong>The customer creates jobs in the portal.</div>}
        {jobs.map((j) => {
          const chip = j.archivedAt ? { label: "Archived", tone: "red" } : STATUS_CHIP[j.status];
          return (
            <div key={j.id} className={`trow${j.archivedAt ? " dim" : ""}`} style={{ gridTemplateColumns: COLS, fontSize: 13.5 }}>
              <span style={{ minWidth: 0 }}>
                <span className="cell-strong">{j.title}</span>
                <div className="cell-sub">
                  Created {j.createdAt}{j.archivedAt ? ` · archived ${j.archivedAt}` : ""}{j.approvedDescription ? "" : " · no approved description"}
                </div>
              </span>
              <span><span className={`chip chip-${chip.tone}`}>{chip.label}</span></span>
              <span>{j.candidates.toLocaleString("en-IN")}</span>
              <span className={j.screeningThreshold === null ? "cell-muted" : undefined}>
                {j.screeningThreshold ?? `${defaultThreshold}, default`}
              </span>
              <span className={j.override ? undefined : "cell-muted"}>
                {j.override ? `Own · ${j.override.durationMinutes} min` : "Workspace default"}
              </span>
              {canEdit ? (
                <ActionMenu label={`Actions for ${j.title}`}>
                  {j.archivedAt ? (
                    <button onClick={() => setOpen({ action: "restore", job: j })}>Restore</button>
                  ) : (
                    <>
                      <button onClick={() => setOpen({ action: "edit", job: j })}>Edit job</button>
                      <button onClick={() => setOpen({ action: "interview", job: j })}>
                        {j.override ? "Edit interview settings" : "Give it its own interview settings"}
                      </button>
                      {j.override && <button onClick={() => setOpen({ action: "default", job: j })}>Use workspace interview settings</button>}
                      <button className="danger" onClick={() => setOpen({ action: "archive", job: j })}>Archive</button>
                    </>
                  )}
                </ActionMenu>
              ) : <span />}
            </div>
          );
        })}
        <div className="tfoot">
          <span className="grow">
            {active} active {active === 1 ? "job" : "jobs"}{jobLimit === null ? ", no limit on this plan" : ` of ${jobLimit} the plan allows`}.
            Archiving never deletes: candidates, calls and reports stay.
          </span>
        </div>
      </div>
      {open?.action === "edit" && <JobDialog wsId={wsId} job={open.job} onClose={() => setOpen(null)} onDone={done} />}
      {open?.action === "interview" && (
        <InterviewDialog wsId={wsId} jobId={open.job.id} protocol={open.job.override ?? workspaceProtocol} rules={rules}
          title={`Interview settings for ${open.job.title}`} onClose={() => setOpen(null)} onDone={done} />
      )}
      {open?.action === "default" && (
        <EditDialog title={`Use workspace interview settings for ${open.job.title}`} path={`/api/workspaces/${wsId}/interview/reset`}
          confirm="Use workspace settings" payload={() => ({ jobId: open.job.id })} onClose={() => setOpen(null)} onDone={done}>
          <div className="dialog-body">This job&apos;s own settings are removed, and its next call uses the workspace&apos;s.</div>
        </EditDialog>
      )}
      {(open?.action === "archive" || open?.action === "restore") && (
        <EditDialog title={`${open.action === "archive" ? "Archive" : "Restore"} ${open.job.title}`}
          path={`/api/workspaces/${wsId}/jobs/${open.job.id}/${open.action}`} confirm={open.action === "archive" ? "Archive job" : "Restore job"}
          danger={open.action === "archive"} payload={() => ({})} onClose={() => setOpen(null)} onDone={done}>
          <div className="dialog-body">
            {open.action === "archive"
              ? `The job closes and disappears from the portal. Its ${open.job.candidates} candidates, their calls and reports are kept, and Restore brings it back.`
              : "The job comes back to the portal, closed. The customer reopens it when they are ready."}
          </div>
        </EditDialog>
      )}
      {toast.node}
    </>
  );
}

function JobDialog({ wsId, job, onClose, onDone }: { wsId: string; job: JobRow; onClose: () => void; onDone: (msg: string) => void }) {
  const [title, setTitle] = useState(job.title);
  const [status, setStatus] = useState<JobRow["status"]>(job.status);
  const [threshold, setThreshold] = useState(job.screeningThreshold === null ? "" : String(job.screeningThreshold));
  const options = (["open", "paused", "closed"] as const).filter((s) => s === job.status || s !== "open" || job.approvedDescription);

  return (
    <EditDialog title={`Edit ${job.title}`} path={`/api/workspaces/${wsId}/jobs/${job.id}`} confirm="Save job" onClose={onClose} onDone={onDone}
      ready={Boolean(title.trim())}
      payload={() => ({ title, status, screeningThreshold: threshold === "" ? null : Number(threshold) })}>
      <TextField id="job-title" label="Title" value={title} onChange={setTitle} max={200} />
      <div className="grid-2" style={{ gap: 10 }}>
        <div className="field">
          <label className="label" htmlFor="job-status">Status</label>
          <select id="job-status" className="select" value={status} onChange={(e) => setStatus(e.target.value as JobRow["status"])}>
            {job.status === "draft" && <option value="draft">Draft</option>}
            {options.map((s) => <option key={s} value={s}>{STATUS_CHIP[s].label}</option>)}
          </select>
          {!job.approvedDescription && job.status !== "open" && (
            <span className="hint">It cannot open until the customer approves a description.</span>
          )}
        </div>
        <div className="field">
          <label className="label" htmlFor="job-threshold">Screening threshold</label>
          <input id="job-threshold" className="input" inputMode="numeric" value={threshold} placeholder="Platform default"
            onChange={(e) => setThreshold(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          <span className="hint">A match score from 0 to 100. Blank uses the platform default.</span>
        </div>
      </div>
    </EditDialog>
  );
}
