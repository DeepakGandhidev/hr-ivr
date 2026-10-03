"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ActionMenu, { type ActionMenuItem } from "@/components/ActionMenu";
import Dialog from "@/components/Dialog";
import ScreeningAnalysisDialog, { shortDate } from "@/components/ScreeningAnalysisDialog";
import { useToast } from "@/components/Toast";
import { displayName, NO_JOB_ROUTING } from "@/lib/candidates";

type View = "all" | "no_job" | "no_phone" | "awaiting" | "not_applications" | "archived";
type BulkAction = "archive" | "restore" | "not_application" | "is_application" | "screen" | "assign";

interface Row {
  id: string;
  name: string | null;
  nameSource: "cv" | "sender" | "subject" | null;
  email: string | null;
  phone: string | null;
  jobId: string;
  jobTitle: string;
  routedBy: string | null;
  routingConfidence: number | null;
  hasCvFile: boolean;
  createdAt: string;
  queued: boolean;
  archivedAt: string | null;
  archivedByName: string | null;
  notApplicationAt: string | null;
  screeningId: string | null;
  score: number | null;
}

interface PipelineData {
  rows: Row[];
  counts: Record<View, number>;
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  jobs: { id: string; title: string; status: string }[];
  mode: "auto" | "manual";
  usage: { used: number; allowance: number };
  junk: { enabled: boolean; rule: string[] };
  permissions: { canEdit: boolean; canScreen: boolean; canChangeMode: boolean };
}

const CHIPS: { view: View; label: string }[] = [
  { view: "all", label: "All" },
  { view: "no_job", label: "No job" },
  { view: "no_phone", label: "No phone" },
  { view: "awaiting", label: "Awaiting screen" },
  { view: "not_applications", label: "Not applications" },
  { view: "archived", label: "Archived" },
];

const noJob = (r: Row) => r.routedBy === NO_JOB_ROUTING;
const unscreenedWithJob = (r: Row) => !noJob(r) && !r.screeningId && !r.queued;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** +919650434451 → +91 96504 34451; anything else as stored. */
function formatPhone(p: string) {
  const m = /^\+91(\d{5})(\d{5})$/.exec(p);
  return m ? `+91 ${m[1]} ${m[2]}` : p;
}

/** Page numbers with gaps: 1 2 3 … 9 */
function pageList(page: number, pages: number): (number | "gap")[] {
  const keep = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3].forEach((p) => keep.add(p));
  const sorted = Array.from(keep).filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

export default function PipelinePage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const toast = useToast(4000);

  const [view, setView] = useState<View>("all");
  const [jobId, setJobId] = useState("");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PipelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const [analysisFor, setAnalysisFor] = useState<string | null>(null);
  const [assignFor, setAssignFor] = useState<Row[] | null>(null);
  const [archiveFor, setArchiveFor] = useState<Row[] | null>(null);
  const [phoneFor, setPhoneFor] = useState<string | null>(null);

  // Search waits for a pause in typing rather than querying per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    const sp = new URLSearchParams({ view, page: String(page) });
    if (jobId) sp.set("jobId", jobId);
    if (q) sp.set("q", q);
    try {
      const r = await fetch(`/api/${tenant}/pipeline?${sp}`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || "Could not load the pipeline");
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the pipeline");
    }
  }, [tenant, view, page, jobId, q]);

  useEffect(() => {
    void load();
  }, [load]);

  // Selection is per page: changing what is shown clears it.
  useEffect(() => setSelected(new Set()), [view, page, jobId, q]);

  // While anything on screen is queued, follow it until it is screened.
  const anyQueued = data?.rows.some((r) => r.queued) ?? false;
  useEffect(() => {
    if (!anyQueued) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [anyQueued, load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const perms = data?.permissions;
  const picked = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run(action: BulkAction, targets: Row[], extra: { jobId?: string } = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/${tenant}/pipeline/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids: targets.map((r) => r.id), ...extra }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message || "That did not work");
      const who = targets.length === 1 ? nameOf(targets[0]) : plural(targets.length, "candidate");
      const msg: Record<BulkAction, string> = {
        archive: `Archived ${who}. Restore from the Archived filter.`,
        restore: `Restored ${who}.`,
        not_application: `Marked ${who} as not an application.`,
        is_application: `${who} back in the pipeline.`,
        screen: `Screening ${plural(d.queued ?? targets.length, "candidate")}.`,
        assign:
          d.queued > 0
            ? `Moved ${who}. Screening against the new job.`
            : `Moved ${who}. They are awaiting a screen.`,
      };
      toast.show(msg[action]);
      setSelected(new Set());
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setMode(mode: "auto" | "manual") {
    if (!data || data.mode === mode) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/${tenant}/pipeline/mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message || "Could not change the mode");
      setData({ ...data, mode });
      toast.show(mode === "auto" ? "Auto screening is on for new arrivals." : "New arrivals now wait for you to screen them.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the mode");
    } finally {
      setBusy(false);
    }
  }

  const isJunk = (r: Row) =>
    !!data?.junk.enabled &&
    data.junk.rule.length > 0 &&
    data.junk.rule.every((c) =>
      c === "no_phone" ? !r.phone : c === "no_job" ? noJob(r) : c === "subject_name" ? r.nameSource === "subject" : false
    );

  // --- bulk bar ------------------------------------------------------------
  const inactiveView = view === "archived" || view === "not_applications";
  const anyNoJob = picked.some(noJob);
  const toScreen = picked.filter(unscreenedWithJob);
  const costs: string[] = [];
  if (!inactiveView && data?.mode === "auto" && perms?.canEdit) {
    costs.push(`Assigning a job screens them next, using ${plural(picked.length, "screening")}`);
  }
  if (!inactiveView && toScreen.length && perms?.canScreen) {
    costs.push(`Screen now uses ${plural(toScreen.length, "screening")}`);
  }

  const from = data && data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.total, data.page * data.pageSize) : 0;

  return (
    <div className="jm pl">
      <div className="pl-head">
        <div>
          <h1>Pipeline</h1>
          <p className="muted">Every application that arrived, newest first, and the ones that need a hand from you.</p>
        </div>
        {data && (
          <div className="pl-mode">
            <div className="seg" role="group" aria-label="Screening mode">
              <button
                type="button"
                aria-pressed={data.mode === "auto"}
                disabled={busy || !perms?.canChangeMode}
                onClick={() => setMode("auto")}
              >
                Auto screening
              </button>
              <button
                type="button"
                aria-pressed={data.mode === "manual"}
                disabled={busy || !perms?.canChangeMode}
                onClick={() => setMode("manual")}
              >
                Manual
              </button>
            </div>
            <p className="pl-mode-line">
              Auto screens matched applications as they arrive. Manual queues them for you. {data.usage.used} of{" "}
              {data.usage.allowance} screenings used this month.
            </p>
          </div>
        )}
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <div className="jm-toolbar pl-toolbar">
        <input
          type="search"
          className="jm-search"
          placeholder="Search name, email or phone"
          aria-label="Search name, email or phone"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="jm-select">
          <span className="jm-select-label">Job:</span>
          <select
            value={jobId}
            onChange={(e) => {
              setJobId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {data?.jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="pl-chips" role="group" aria-label="Filter">
        {CHIPS.map((c) => (
          <button
            key={c.view}
            type="button"
            className="pl-chip"
            aria-pressed={view === c.view}
            onClick={() => {
              setView(c.view);
              setPage(1);
            }}
          >
            {c.label} · {data?.counts[c.view] ?? "…"}
          </button>
        ))}
      </div>

      {picked.length > 0 && (
        <div className="pl-bulk" role="region" aria-label="Bulk actions">
          <strong>{picked.length} selected</strong>
          {view === "archived" ? (
            perms?.canEdit && (
              <button type="button" className="btn-ink sm" disabled={busy} onClick={() => run("restore", picked)}>
                Restore
              </button>
            )
          ) : (
            <>
              {perms?.canEdit && view !== "not_applications" && (
                <button type="button" className="btn-ink sm" disabled={busy} onClick={() => setAssignFor(picked)}>
                  {anyNoJob ? "Assign to a job" : "Move to another job"}
                </button>
              )}
              {perms?.canScreen && view !== "not_applications" && toScreen.length > 0 && (
                <button type="button" className="btn-line sm" disabled={busy} onClick={() => run("screen", toScreen)}>
                  Screen now
                </button>
              )}
              {perms?.canEdit && view === "not_applications" && (
                <button type="button" className="btn-ink sm" disabled={busy} onClick={() => run("is_application", picked)}>
                  It is an application
                </button>
              )}
              {perms?.canEdit && (
                <button type="button" className="btn-line sm" disabled={busy} onClick={() => setArchiveFor(picked)}>
                  Archive
                </button>
              )}
              {perms?.canEdit && view !== "not_applications" && (
                <button type="button" className="btn-line sm" disabled={busy} onClick={() => run("not_application", picked)}>
                  Mark not an application
                </button>
              )}
            </>
          )}
          {costs.length > 0 && <span className="pl-cost">{costs.join(" · ")}</span>}
          <span className="jm-spacer" />
          <button type="button" className="btn-link" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {!data ? (
        !error && <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="jm-card empty">
          <p>{q || jobId ? "Nothing matches this search." : "Nothing here."}</p>
        </div>
      ) : (
        <div className="jm-card flush">
          <table className="rtable pl-table">
            <caption className="visually-hidden">Pipeline</caption>
            <colgroup>
              <col className="c-check" />
              <col className="c-cand" />
              <col className="c-job" />
              <col className="c-phone" />
              <col className="c-route" />
              <col className="c-screen" />
              <col className="c-date" />
              <col className="c-menu" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">
                  <input
                    type="checkbox"
                    aria-label="Select every candidate on this page"
                    checked={allOnPage}
                    onChange={() => setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)))}
                  />
                </th>
                <th scope="col">Candidate</th>
                <th scope="col">Job</th>
                <th scope="col">Phone</th>
                <th scope="col">Routing</th>
                <th scope="col">Screening</th>
                <th scope="col">Received</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <PipelineRowView
                  key={r.id}
                  tenant={tenant}
                  row={r}
                  view={view}
                  mode={data.mode}
                  perms={data.permissions}
                  busy={busy}
                  checked={selected.has(r.id)}
                  junk={isJunk(r)}
                  phoneOpen={phoneFor === r.id}
                  onToggle={() => toggle(r.id)}
                  onOpenAnalysis={() => setAnalysisFor(r.id)}
                  onAssign={() => setAssignFor([r])}
                  onArchive={() => run("archive", [r])}
                  onRestore={() => run("restore", [r])}
                  onNotApplication={() => run("not_application", [r])}
                  onIsApplication={() => run("is_application", [r])}
                  onScreen={() => run("screen", [r])}
                  onPhone={(open) => setPhoneFor(open ? r.id : null)}
                  onPhoneSaved={() => {
                    setPhoneFor(null);
                    toast.show(`Number saved for ${nameOf(r)}.`);
                    void load();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 0 && (
        <nav className="pl-pager" aria-label="Pages">
          <span className="muted small">
            Showing {from} to {to} of {data.total}
          </span>
          <span className="jm-spacer" />
          <button type="button" className="btn-line sm" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
            Previous
          </button>
          {pageList(data.page, data.pages).map((p, i) =>
            p === "gap" ? (
              <span key={`g${i}`} className="pl-gap" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                className="pl-page"
                aria-current={p === data.page ? "page" : undefined}
                aria-label={`Page ${p}`}
                onClick={() => setPage(p)}
              >
                {p}
              </button>
            )
          )}
          <button type="button" className="btn-line sm" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>
            Next
          </button>
        </nav>
      )}

      <p className="muted small pl-foot">
        Screened chips open the analysis. Archived candidates disappear from every list and count, and live only under the
        Archived filter, with Restore.
      </p>

      {analysisFor && data && (
        <ScreeningAnalysisDialog
          tenant={tenant}
          candidateId={analysisFor}
          canEdit={data.permissions.canEdit}
          onClose={() => setAnalysisFor(null)}
          onShortlisted={(m) => {
            toast.show(m);
            void load();
          }}
          onMove={() => {
            const r = rows.find((x) => x.id === analysisFor);
            setAnalysisFor(null);
            if (r) setAssignFor([r]);
          }}
        />
      )}

      {assignFor && data && (
        <AssignDialog
          rows={assignFor}
          jobs={data.jobs}
          mode={data.mode}
          busy={busy}
          onClose={() => setAssignFor(null)}
          onAssign={async (target) => {
            if (await run("assign", assignFor, { jobId: target })) setAssignFor(null);
          }}
        />
      )}

      {archiveFor && (
        <Dialog title="Archive" onClose={() => setArchiveFor(null)} busy={busy}>
          <p>
            Archive {archiveFor.length} candidates? They disappear from every list and shortlist. You can restore them
            from the Archived filter.
          </p>
          <div className="jm-dialog-actions">
            <button type="button" className="btn-line" onClick={() => setArchiveFor(null)} disabled={busy} data-autofocus>
              Cancel
            </button>
            <button
              type="button"
              className="btn-ink"
              disabled={busy}
              onClick={async () => {
                if (await run("archive", archiveFor)) setArchiveFor(null);
              }}
            >
              {busy ? "Archiving…" : `Archive ${archiveFor.length}`}
            </button>
          </div>
        </Dialog>
      )}

      {toast.node}
    </div>
  );
}

function nameOf(r: Row) {
  return displayName(r.name) ?? r.email ?? "this candidate";
}

function PipelineRowView({
  tenant,
  row: r,
  view,
  mode,
  perms,
  busy,
  checked,
  junk,
  phoneOpen,
  onToggle,
  onOpenAnalysis,
  onAssign,
  onArchive,
  onRestore,
  onNotApplication,
  onIsApplication,
  onScreen,
  onPhone,
  onPhoneSaved,
}: {
  tenant: string;
  row: Row;
  view: View;
  mode: "auto" | "manual";
  perms: PipelineData["permissions"];
  busy: boolean;
  checked: boolean;
  junk: boolean;
  phoneOpen: boolean;
  onToggle: () => void;
  onOpenAnalysis: () => void;
  onAssign: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onNotApplication: () => void;
  onIsApplication: () => void;
  onScreen: () => void;
  onPhone: (open: boolean) => void;
  onPhoneSaved: () => void;
}) {
  const name = nameOf(r);
  const fromSubject = r.nameSource === "subject";
  const archived = !!r.archivedAt;
  const notApp = !!r.notApplicationAt;
  const inactive = archived || notApp;

  const menu: ActionMenuItem[] = [{ label: "View candidate", href: `/${tenant}/candidates/${r.id}` }];
  if (archived) {
    if (perms.canEdit) menu.push({ label: "Restore", onSelect: onRestore });
  } else if (notApp) {
    if (perms.canEdit) {
      menu.push({ label: "It is an application", onSelect: onIsApplication });
      menu.push({ label: "Archive", onSelect: onArchive, danger: true });
    }
  } else {
    if (perms.canEdit) menu.push({ label: noJob(r) ? "Assign to a job" : "Move to another job", onSelect: onAssign });
    if (perms.canScreen)
      menu.push({
        label: "Screen now",
        onSelect: onScreen,
        disabled: noJob(r) || r.queued,
        hint: noJob(r) ? "Assign a job first" : r.queued ? "Already queued" : undefined,
      });
    if (perms.canEdit) {
      menu.push({ label: "Add a number", onSelect: () => onPhone(true), disabled: !!r.phone, hint: r.phone ? "Already has one" : undefined });
      menu.push({ label: "Mark not an application", onSelect: onNotApplication });
      menu.push({ label: "Archive", onSelect: onArchive, danger: true });
    }
  }

  let screening: React.ReactNode;
  if (r.screeningId && r.score !== null) {
    screening = (
      <button type="button" className="chip chip-green pl-screened" onClick={onOpenAnalysis} aria-label={`Screened, ${r.score}. Open the analysis for ${name}`}>
        Screened · {r.score}
      </button>
    );
  } else if (r.queued) {
    screening = <span className="chip chip-neutral">Queued</span>;
  } else if (noJob(r)) {
    screening = junk && perms.canEdit && !inactive ? (
      <span className="pl-junk">
        Junk?{" "}
        <button type="button" className="btn-link" onClick={onNotApplication} aria-label={`Mark ${name} not an application`}>
          Not an application
        </button>
      </span>
    ) : (
      <span className="chip chip-neutral">Waiting for a job</span>
    );
  } else {
    screening = <span className={`chip ${mode === "manual" ? "chip-amber" : "chip-neutral"}`}>Awaiting screen</span>;
  }

  return (
    <tr className={checked ? "is-open" : undefined}>
      <td data-label="Select">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Select ${name}`} />
      </td>
      <td data-label="Candidate">
        <div className={`cell-name${fromSubject ? " pl-subject" : ""}`}>
          <Link href={`/${tenant}/candidates/${r.id}`}>{name}</Link>
          {fromSubject && <span className="pl-tag">from subject</span>}
        </div>
        <div className="cell-sub">
          {r.email}
          {r.hasCvFile && (
            <>
              {r.email && " · "}
              <a href={`/api/${tenant}/candidates/${r.id}/cv`} target="_blank" rel="noreferrer" aria-label={`View CV of ${name}`}>
                CV
              </a>
            </>
          )}
        </div>
        {archived && (
          <div className="cell-sub">
            Archived by {r.archivedByName ?? "someone"} · {shortDate(r.archivedAt!)}
          </div>
        )}
      </td>
      <td data-label="Job">{noJob(r) ? <span className="muted">—</span> : r.jobTitle}</td>
      <td data-label="Phone">
        {phoneOpen ? (
          <PhoneField tenant={tenant} id={r.id} name={name} onCancel={() => onPhone(false)} onSaved={onPhoneSaved} />
        ) : r.phone ? (
          <span className="pl-nowrap">{formatPhone(r.phone)}</span>
        ) : (
          <span className="pl-nowrap">
            <span className="chip chip-clay sm">No phone</span>
            {perms.canEdit && !inactive && (
              <>
                {" "}
                <button type="button" className="btn-link" onClick={() => onPhone(true)} aria-label={`Add a number for ${name}`}>
                  Add
                </button>
              </>
            )}
          </span>
        )}
      </td>
      <td data-label="Routing">
        {noJob(r) ? (
          <span className="pl-nowrap">
            <span className="chip chip-amber sm">No job yet</span>
            {perms.canEdit && !inactive && (
              <>
                {" "}
                <button type="button" className="btn-link" onClick={onAssign} aria-label={`Assign ${name} to a job`}>
                  Assign
                </button>
              </>
            )}
          </span>
        ) : r.routedBy === "manual" ? (
          <span className="chip chip-neutral sm">Added by you</span>
        ) : (
          <span className="chip chip-green sm">Matched {Math.round(r.routingConfidence ?? 100)}%</span>
        )}
      </td>
      <td data-label="Screening">{inactive && !r.screeningId ? <span className="muted">—</span> : screening}</td>
      <td data-label="Received" className="pl-nowrap">
        {shortDate(r.createdAt)}
      </td>
      <td className="cell-actions">
        <ActionMenu label={`More actions for ${name}`} items={menu} size="sm" />
        {busy && <span className="visually-hidden">Working</span>}
      </td>
    </tr>
  );
}

function PhoneField({
  tenant,
  id,
  name,
  onCancel,
  onSaved,
}: {
  tenant: string;
  id: string;
  name: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => input.current?.focus(), []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/${tenant}/candidates/${id}/phone`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: value }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message || "Could not save the number");
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not save the number");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="pl-phone" onSubmit={save} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <input
        ref={input}
        type="tel"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="+91 98765 43210"
        aria-label={`Phone number for ${name}`}
        aria-invalid={err ? true : undefined}
      />
      <button type="submit" className="btn-ink sm" disabled={saving || !value.trim()}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button type="button" className="btn-link" onClick={onCancel}>
        Cancel
      </button>
      {err && (
        <span className="text-danger small" role="alert">
          {err}
        </span>
      )}
    </form>
  );
}

function AssignDialog({
  rows,
  jobs,
  mode,
  busy,
  onClose,
  onAssign,
}: {
  rows: Row[];
  jobs: PipelineData["jobs"];
  mode: "auto" | "manual";
  busy: boolean;
  onClose: () => void;
  onAssign: (jobId: string) => void;
}) {
  const single = rows.length === 1 ? rows[0] : null;
  const current = single && !noJob(single) ? single.jobId : "";
  const options = jobs.filter((j) => j.id !== current);
  const [target, setTarget] = useState(options[0]?.id ?? "");
  const moving = rows.some((r) => !noJob(r));

  return (
    <Dialog title={moving ? "Move to another job" : "Assign to a job"} onClose={onClose} busy={busy}>
      <p className="muted">
        {single ? nameOf(single) : plural(rows.length, "candidate")}
        {single && !noJob(single) ? `, now on ${single.jobTitle}` : ""}
      </p>
      <label>
        <span>Job</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {options.map((j) => (
            <option key={j.id} value={j.id}>
              {j.title}
              {j.status !== "open" ? ` (${j.status})` : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="small muted">
        {mode === "auto"
          ? `Assigning a job screens them next, using ${plural(rows.length, "screening")}`
          : "They wait as Awaiting screen until you screen them."}
        {moving && " Earlier screenings stay in their history."}
      </p>
      <div className="jm-dialog-actions">
        <button type="button" className="btn-line" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn-ink" disabled={busy || !target} onClick={() => onAssign(target)}>
          {busy ? "Saving…" : moving ? "Move" : "Assign"}
        </button>
      </div>
    </Dialog>
  );
}
