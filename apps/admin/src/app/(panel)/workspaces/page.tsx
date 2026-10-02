import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/session";
import { panelContext } from "@/lib/panel-context";
import { getSetting } from "@/lib/settings";
import {
  filterWhere,
  searchWhere,
  workspaceCounts,
  workspaceRows,
  meterPercent,
  type WorkspaceFilter,
  type WorkspaceSort,
} from "@/lib/workspaces";
import { inr, num, shortDate } from "@/lib/format";
import { WorkspaceRowMenu } from "@/components/WorkspaceActions";
import { CreateWorkspaceButton } from "./CreateWorkspace";

export const dynamic = "force-dynamic";

const COLS = "minmax(0, 1fr) 90px 100px 150px 80px 120px 80px 40px";

const FILTERS: { key: WorkspaceFilter; label: string; always: boolean }[] = [
  { key: "all", label: "All", always: true },
  { key: "paying", label: "Paying", always: true },
  { key: "trial", label: "Trial", always: true },
  { key: "past_due", label: "Past due", always: true },
  { key: "suspended", label: "Suspended", always: true },
  { key: "deleted_pending", label: "Deletion pending", always: false },
];

const SORTS: { key: WorkspaceSort; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "name", label: "Name" },
  { key: "minutes", label: "Minutes used" },
];

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: { q?: string; filter?: string; sort?: string; page?: string };
}) {
  const { admin, session } = await requireAdminPage();
  const q = searchParams.q?.trim() || undefined;
  const filter = (FILTERS.find((f) => f.key === searchParams.filter)?.key ?? "all") as WorkspaceFilter;
  const sort = (SORTS.find((s) => s.key === searchParams.sort)?.key ?? "newest") as WorkspaceSort;
  const pageSize = Math.max(5, Number(await getSetting("lists.page_size")) || 25);

  const where = { AND: [searchWhere(q), filterWhere(filter)] };
  const counts = await workspaceCounts(q);
  const total = counts[filter];
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(searchParams.page) || 1));

  const [rows, ctx] = await Promise.all([
    workspaceRows(where, { sort, skip: (page - 1) * pageSize, take: pageSize }),
    panelContext(admin, session),
  ]);

  const href = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const merged = { q, filter, sort, page, ...over };
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined || v === "" || (k === "filter" && v === "all") || (k === "sort" && v === "newest") || (k === "page" && v === 1)) continue;
      p.set(k, String(v));
    }
    const s = p.toString();
    return `/workspaces${s ? `?${s}` : ""}`;
  };

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const nothingAtAll = counts.all === 0 && !q;

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Workspaces</h1>
          <p className="page-sub">Every company on Pratibha, and the state of their account.</p>
        </div>
        {ctx.allowed["workspace.create"] && <CreateWorkspaceButton plans={ctx.plans} />}
      </div>

      <form className="toolbar" action="/workspaces">
        <input type="search" name="q" defaultValue={q} placeholder="Search name, owner email or GSTIN"
          aria-label="Search workspaces" className="input search" />
        {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
        {sort !== "newest" && <input type="hidden" name="sort" value={sort} />}
        <div className="pills">
          {FILTERS.filter((f) => f.always || counts[f.key] > 0).map((f) => (
            <Link key={f.key} href={href({ filter: f.key, page: 1 })} className={`pill${filter === f.key ? " on" : ""}`}>
              {f.label} · {num(counts[f.key])}
            </Link>
          ))}
        </div>
        <div className="grow" />
        <SortLinks current={sort} hrefFor={(s) => href({ sort: s, page: 1 })} />
      </form>

      <div className="table">
        <div className="trow head" style={{ gridTemplateColumns: COLS }}>
          <div>Workspace</div><div>Plan</div><div>MRR</div><div>Minutes</div><div>Members</div><div>Status</div><div>Joined</div><div />
        </div>

        {rows.length === 0 ? (
          <div className="empty">
            {nothingAtAll ? (
              <>
                <strong>No workspaces yet</strong>
                <span>When a company signs up, or you create one, it appears here.</span>
                {ctx.allowed["workspace.create"] && <CreateWorkspaceButton plans={ctx.plans} />}
              </>
            ) : (
              <>
                <strong>Nothing matches</strong>
                <span>{q ? `No workspace matches “${q}”` : "No workspace is in this state"}{filter !== "all" ? " under this filter" : ""}.</span>
                <Link className="btn sm" href="/workspaces">Clear search and filters</Link>
              </>
            )}
          </div>
        ) : (
          rows.map((r) => {
            const pct = meterPercent(r.minutesUsed, r.minutesAllowed);
            return (
              <div key={r.id} className={`trow${r.statusChip.label !== "Active" ? " highlight" : ""}`} style={{ gridTemplateColumns: COLS }}>
                <div style={{ minWidth: 0 }}>
                  <Link href={`/workspaces/${r.id}`} className="cell-strong" style={{ textDecoration: "none" }}>{r.name}</Link>
                  <div className="cell-sub">{r.ownerEmail ?? "No owner on record"}</div>
                </div>
                <div><span className={`chip chip-${r.planChip.tone}`}>{r.planChip.label}</span></div>
                <div style={{ fontSize: 13, color: r.mrr ? undefined : "var(--muted)" }}>{r.mrr ? inr(r.mrr) : "—"}</div>
                <div>
                  <div className="meter-label">{num(r.minutesUsed)} of {num(r.minutesAllowed)}</div>
                  <div className={`meter${pct >= 100 ? " warn" : ""}`}><div style={{ width: `${pct}%` }} /></div>
                </div>
                <div style={{ fontSize: 13 }}>{r.members}</div>
                <div><span className={`chip chip-${r.statusChip.tone}`}>{r.statusChip.label}</span></div>
                <div className="cell-muted">{shortDate(r.createdAt)}</div>
                <WorkspaceRowMenu ws={{ id: r.id, name: r.name, status: r.status, planKey: r.planKey, planName: r.planName }} ctx={ctx} />
              </div>
            );
          })
        )}

        <div className="tfoot">
          <span>
            Showing {from} to {to} of {num(total)} · The menu holds Open, Change plan, Add minutes, Sign in as workspace,
            Suspend. Delete lives only inside the workspace, behind its own guardrails.
          </span>
          <div className="grow" />
          {page > 1 ? <Link className="btn sm" href={href({ page: page - 1 })}>Previous</Link> : <span className="btn sm" aria-disabled="true">Previous</span>}
          {page < pages ? <Link className="btn sm" href={href({ page: page + 1 })}>Next</Link> : <span className="btn sm" aria-disabled="true">Next</span>}
        </div>
      </div>
    </>
  );
}

function SortLinks({ current, hrefFor }: { current: WorkspaceSort; hrefFor: (s: WorkspaceSort) => string }) {
  const label = SORTS.find((s) => s.key === current)?.label;
  return (
    <details className="menu-wrap">
      <summary className="btn md" style={{ listStyle: "none" }}>Sort: {label}</summary>
      <div className="menu">
        {SORTS.map((s) => (
          <Link key={s.key} href={hrefFor(s.key)}>{s.label}</Link>
        ))}
      </div>
    </details>
  );
}
