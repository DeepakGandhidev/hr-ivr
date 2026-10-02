"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { Dialog, ReasonField, useToast } from "@/components/ui";

type Match = { candidateId: string; name: string; email: string | null; status: string; job: string; tenantId: string; tenantName: string };

export function FindCandidateButton({ number }: { number: string }) {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    setOpen(true);
    setMatches(null);
    setError(null);
    try {
      const res = await api<{ matches: Match[] }>(`/api/calls/find?number=${encodeURIComponent(number)}`, undefined, "GET");
      setMatches(res.matches);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <button className="btn sm" onClick={find}>Find candidate</button>
      {open && (
        <Dialog title={`Candidates on ${number}`} onClose={() => setOpen(false)}>
          {error && <div className="error-text">{error}</div>}
          {!matches && !error && <div className="hint">Searching every workspace…</div>}
          {matches && matches.length === 0 && (
            <div className="dialog-body">No candidate in any workspace has this number, or one ending in the same ten digits.</div>
          )}
          {matches && matches.map((m) => (
            <div key={m.candidateId} className="card-row" style={{ fontSize: 13.5 }}>
              <span className="grow"><b>{m.name}</b> · {m.job} · {m.status}{m.email ? ` · ${m.email}` : ""}</span>
              <Link className="btn sm" href={`/workspaces/${m.tenantId}`}>Open in {m.tenantName}</Link>
            </div>
          ))}
          <div className="dialog-actions"><button className="btn" onClick={() => setOpen(false)}>Close</button></div>
        </Dialog>
      )}
    </>
  );
}

/** Block or unblock, as one control, so it stays mounted (and its confirmation shows) when the row flips. */
export function BlockToggle({ number, blocked, tries }: { number: string; blocked: boolean; tries?: number }) {
  return blocked ? (
    <NumberAction number={number} action="unblock" label="Unblock" prompt={`Let ${number} call again?`} />
  ) : (
    <NumberAction
      number={number}
      action="block"
      label="Block"
      prompt={`Block ${number}? Its next call is refused at the line, before the agent answers, and appears nowhere as usage.${tries ? ` It has called ${tries} ${tries === 1 ? "time" : "times"}.` : ""}`}
    />
  );
}

function NumberAction({ number, action, label, prompt }: { number: string; action: "block" | "unblock"; label: string; prompt: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>(`/api/calls/${action}`, { number, reason });
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
      <button className={`btn sm${action === "block" ? " btn-danger" : ""}`} onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <Dialog title={`${label} ${number}`} onClose={() => setOpen(false)} busy={busy}>
          <div className="dialog-body">{prompt}</div>
          <ReasonField value={reason} onChange={setReason} placeholder={action === "block" ? "For example: six silent calls" : "Recorded in the activity log"} />
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
            <button className={`btn ${action === "block" ? "btn-danger-solid" : "btn-primary"}`} onClick={submit} disabled={busy}>{label}</button>
          </div>
        </Dialog>
      )}
      {toast.node}
    </>
  );
}
