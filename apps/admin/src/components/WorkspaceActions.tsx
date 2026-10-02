"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PanelContext } from "@/lib/panel-context";
import { api } from "@/lib/client";
import { ActionMenu, Dialog, ReasonField, useToast } from "@/components/ui";

export interface WorkspaceRef {
  id: string;
  name: string;
  status: string;
  planKey: string;
  planName: string;
}

export type WorkspaceDialog = "minutes" | "plan" | "signin" | "suspend" | "resume" | null;

/** Copy strings, verbatim from the build request. */
export const SIGN_IN_AS_PROMPT =
  "Why are you signing in as this workspace? The reason is recorded and visible in the activity log.";

const METHODS = [
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
];

/** The ⋯ menu on a workspace row: Open, Change plan, Add minutes, Sign in as, Suspend. */
export function WorkspaceRowMenu({ ws, ctx }: { ws: WorkspaceRef; ctx: PanelContext }) {
  const [dialog, setDialog] = useState<WorkspaceDialog>(null);
  const suspended = ws.status === "suspended";
  const closed = ws.status === "deleted_pending" || ws.status === "deleted";

  return (
    <>
      <ActionMenu label={`Actions for ${ws.name}`}>
        <Link href={`/workspaces/${ws.id}`}>Open</Link>
        {!closed && ctx.allowed["workspace.change_plan"] && <button onClick={() => setDialog("plan")}>Change plan</button>}
        {!closed && (ctx.allowed["workspace.grant_goodwill"] || ctx.allowed["workspace.add_pack"]) && (
          <button onClick={() => setDialog("minutes")}>Add minutes</button>
        )}
        {!closed && ctx.allowed["workspace.sign_in_as"] && (
          <button onClick={() => setDialog("signin")}>Sign in as workspace</button>
        )}
        {!closed && ctx.allowed["workspace.suspend"] && (
          <button className={suspended ? undefined : "danger"} onClick={() => setDialog(suspended ? "resume" : "suspend")}>
            {suspended ? "Resume" : "Suspend"}
          </button>
        )}
        <div className="menu-note">Every Sign in as is logged.</div>
      </ActionMenu>
      <WorkspaceDialogs ws={ws} ctx={ctx} dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

export function WorkspaceDialogs({
  ws,
  ctx,
  dialog,
  onClose,
}: {
  ws: WorkspaceRef;
  ctx: PanelContext;
  dialog: WorkspaceDialog;
  onClose: () => void;
}) {
  const toast = useToast();
  const done = (msg: string) => {
    onClose();
    toast.show(msg);
  };
  return (
    <>
      {dialog === "minutes" && <AddMinutesDialog ws={ws} ctx={ctx} onClose={onClose} onDone={done} />}
      {dialog === "plan" && <ChangePlanDialog ws={ws} ctx={ctx} onClose={onClose} onDone={done} />}
      {dialog === "signin" && <SignInAsDialog ws={ws} ctx={ctx} onClose={onClose} />}
      {(dialog === "suspend" || dialog === "resume") && (
        <SuspendDialog ws={ws} resume={dialog === "resume"} onClose={onClose} onDone={done} />
      )}
      {toast.node}
    </>
  );
}

function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function AddMinutesDialog({
  ws,
  ctx,
  onClose,
  onDone,
}: {
  ws: WorkspaceRef;
  ctx: PanelContext;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const canPack = ctx.allowed["workspace.add_pack"] && ctx.packs.length > 0;
  const [mode, setMode] = useState<"goodwill" | "pack">("goodwill");
  const [minutes, setMinutes] = useState("100");
  const [packId, setPackId] = useState(ctx.packs[0]?.id ?? "");
  const [method, setMethod] = useState("upi");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const { busy, error, run } = useSubmit();
  const capped = ctx.role === "support";

  return (
    <Dialog title={`Add minutes to ${ws.name}`} onClose={onClose} busy={busy}>
      <div className="choice">
        <label className={mode === "goodwill" ? "on" : ""}>
          <input type="radio" checked={mode === "goodwill"} onChange={() => setMode("goodwill")} />
          <b>Goodwill grant</b>
          <span className="hint">Free minutes, no invoice{capped ? `, up to ${ctx.goodwillCap}` : ""}</span>
        </label>
        <label className={mode === "pack" ? "on" : ""} aria-disabled={!canPack}
          title={canPack ? undefined : "Only an Owner or Engineer can record a paid pack."}
          style={canPack ? undefined : { opacity: 0.5, cursor: "not-allowed" }}>
          <input type="radio" checked={mode === "pack"} disabled={!canPack} onChange={() => setMode("pack")} />
          <b>Top up pack</b>
          <span className="hint">A paid pack, invoiced</span>
        </label>
      </div>

      {mode === "goodwill" ? (
        <div className="field">
          <label className="label" htmlFor="minutes">Minutes</label>
          <div className="pills">
            {[50, 100, 250].filter((m) => !capped || m <= ctx.goodwillCap).map((m) => (
              <button key={m} type="button" className={`pill${minutes === String(m) ? " on" : ""}`} onClick={() => setMinutes(String(m))}>
                {m} minutes
              </button>
            ))}
          </div>
          <input id="minutes" className="input" inputMode="numeric" value={minutes}
            onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: 160 }} />
          {capped && <span className="hint">Support can grant up to {ctx.goodwillCap} minutes at a time.</span>}
        </div>
      ) : (
        <>
          <div className="field">
            <label className="label" htmlFor="pack">Pack</label>
            <select id="pack" className="select" value={packId} onChange={(e) => setPackId(e.target.value)}>
              {ctx.packs.map((p) => (
                <option key={p.id} value={p.id}>{p.label} · ₹{p.priceInr.toLocaleString("en-IN")} + GST</option>
              ))}
            </select>
          </div>
          <div className="grid-2" style={{ gap: 10 }}>
            <div className="field">
              <label className="label" htmlFor="method">Paid by</label>
              <select id="method" className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="ref">Reference, optional</label>
              <input id="ref" className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UPI or bank reference" />
            </div>
          </div>
        </>
      )}

      <ReasonField value={reason} onChange={setReason} />
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" disabled={busy}
          onClick={() =>
            run(async () => {
              const res = await api<{ message: string }>(`/api/workspaces/${ws.id}/minutes`,
                mode === "goodwill"
                  ? { mode, minutes: Number(minutes), reason }
                  : { mode, packId, method, reference: reference || undefined, reason });
              onDone(res.message);
            })
          }>
          {busy ? "Saving…" : mode === "goodwill" ? `Grant ${minutes || 0} minutes` : "Record pack"}
        </button>
      </div>
    </Dialog>
  );
}

function ChangePlanDialog({
  ws,
  ctx,
  onClose,
  onDone,
}: {
  ws: WorkspaceRef;
  ctx: PanelContext;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const options = ctx.plans;
  const [planKey, setPlanKey] = useState(options.find((p) => p.key !== ws.planKey)?.key ?? options[0]?.key ?? "");
  const [reason, setReason] = useState("");
  const { busy, error, run } = useSubmit();
  const target = options.find((p) => p.key === planKey);

  return (
    <Dialog title={`Change plan for ${ws.name}`} onClose={onClose} busy={busy}>
      <div className="dialog-body">
        Now on {ws.status === "trial" ? "the trial" : ws.planName}. The change applies the next time anyone in the workspace
        loads a screen.
      </div>
      <div className="field">
        <label className="label" htmlFor="plan">New plan</label>
        <select id="plan" className="select" value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
          {options.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name} · ₹{p.priceInr.toLocaleString("en-IN")} a month · {p.minutes.toLocaleString("en-IN")} minutes
            </option>
          ))}
        </select>
        {target && (
          <span className="hint">
            Moves to the published {target.name} at today&apos;s price. A grandfathered price on the current plan is not kept.
            {ws.status === "trial" ? " The trial ends and the workspace becomes paying." : ""}
          </span>
        )}
      </div>
      <ReasonField value={reason} onChange={setReason} />
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !planKey}
          onClick={() =>
            run(async () => {
              const res = await api<{ message: string }>(`/api/workspaces/${ws.id}/plan`, { planKey, reason });
              onDone(res.message);
            })
          }>
          {busy ? "Saving…" : "Change plan"}
        </button>
      </div>
    </Dialog>
  );
}

function SignInAsDialog({ ws, ctx, onClose }: { ws: WorkspaceRef; ctx: PanelContext; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const { busy, error, run } = useSubmit();

  if (!ctx.twoStepOn) {
    return (
      <Dialog title="Two step verification needed" onClose={onClose}>
        <div className="dialog-body">
          Sign in as gives full access to {ws.name}, so it needs two step verification on your account first. It takes
          about a minute.
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Not now</button>
          <Link className="btn btn-primary" href="/account/two-step">Set up two step verification</Link>
        </div>
      </Dialog>
    );
  }

  if (url) {
    return (
      <Dialog title={`Signed in as ${ws.name}`} onClose={onClose}>
        <div className="dialog-body">
          The link opens the portal as the workspace owner and works once, for a few minutes. It is recorded in the
          activity log with your reason.
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Close</button>
          <a className="btn btn-primary" href={url} target="_blank" rel="noopener noreferrer" onClick={onClose}>
            Open {ws.name}
          </a>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={`Sign in as ${ws.name}`} onClose={onClose} busy={busy}>
      <ReasonField value={reason} onChange={setReason} label={SIGN_IN_AS_PROMPT} placeholder="For example: minutes cap support" />
      {!ctx.codeRecent && (
        <div className="field">
          <label className="label" htmlFor="code">Two step code</label>
          <input id="code" className="input center" inputMode="numeric" autoComplete="one-time-code" maxLength={7}
            value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 200, letterSpacing: "0.2em" }} />
        </div>
      )}
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" disabled={busy}
          onClick={() =>
            run(async () => {
              const res = await api<{ url: string }>(`/api/workspaces/${ws.id}/sign-in-as`, {
                reason,
                code: ctx.codeRecent ? undefined : code,
              });
              setUrl(res.url);
            })
          }>
          {busy ? "Checking…" : "Sign in as workspace"}
        </button>
      </div>
    </Dialog>
  );
}

function SuspendDialog({
  ws,
  resume,
  onClose,
  onDone,
}: {
  ws: WorkspaceRef;
  resume: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [reason, setReason] = useState("");
  const { busy, error, run } = useSubmit();
  return (
    <Dialog title={resume ? `Resume ${ws.name}` : `Suspend ${ws.name}`} onClose={onClose} busy={busy}>
      <div className="dialog-body">
        {resume
          ? "Sign ins, screenings and interviews start again, and the workspace returns exactly as it was before the suspension."
          : "Suspending pauses sign ins, screenings and interviews. Members see a notice telling them to write to start@pratibha.tech, and candidates who call hear a polite refusal. Nothing is deleted, and Resume undoes it."}
      </div>
      <ReasonField value={reason} onChange={setReason} />
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className={`btn ${resume ? "btn-primary" : "btn-danger-solid"}`} disabled={busy}
          onClick={() =>
            run(async () => {
              const res = await api<{ message: string }>(`/api/workspaces/${ws.id}/${resume ? "resume" : "suspend"}`, { reason });
              onDone(res.message);
            })
          }>
          {busy ? "Saving…" : resume ? "Resume workspace" : "Suspend workspace"}
        </button>
      </div>
    </Dialog>
  );
}
