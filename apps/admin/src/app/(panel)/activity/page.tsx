import Link from "next/link";
import type { Prisma } from "@pratibha/prisma";
import { requireAdminPage } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { BILLING_ACTION_PREFIXES, SIGN_IN_AS_ACTION } from "@/lib/activity";
import { num, when } from "@/lib/format";

export const dynamic = "force-dynamic";

const COLS = "150px 120px minmax(0, 1fr) 200px";
const FILTERS = [
  { key: "all", label: "Everything" },
  { key: "admin", label: "Admin actions" },
  { key: "billing", label: "Billing" },
  { key: "signin", label: "Sign in as" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

function where(filter: Filter, q: string | undefined, workspace: string | undefined): Prisma.ActivityLogWhereInput {
  const and: Prisma.ActivityLogWhereInput[] = [];
  if (workspace) and.push({ targetWorkspaceId: workspace });
  if (filter === "admin") and.push({ actorType: "admin" });
  if (filter === "billing") and.push({ OR: BILLING_ACTION_PREFIXES.map((p) => ({ action: { startsWith: p } })) });
  if (filter === "signin") and.push({ action: SIGN_IN_AS_ACTION });
  if (q) {
    and.push({
      OR: [
        { actorName: { contains: q, mode: "insensitive" } },
        { targetWorkspaceName: { contains: q, mode: "insensitive" } },
        { summary: { contains: q, mode: "insensitive" } },
        { action: { contains: q, mode: "insensitive" } },
        { reason: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

/**
 * The activity log, read only. There is no admin API that updates or deletes
 * a row, and the database refuses both even to a superuser (see the
 * activity_log_no_update trigger), so this page is the only face it has.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: { q?: string; filter?: string; workspace?: string; page?: string };
}) {
  await requireAdminPage();
  const q = searchParams.q?.trim() || undefined;
  const workspace = searchParams.workspace || undefined;
  const filter = (FILTERS.find((f) => f.key === searchParams.filter)?.key ?? "all") as Filter;
  const pageSize = Math.max(5, Number(await getSetting("lists.page_size")) || 25);
  const w = where(filter, q, workspace);
  const total = await db.activityLog.count({ where: w });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(searchParams.page) || 1));
  const [rows, scoped] = await Promise.all([
    db.activityLog.findMany({ where: w, orderBy: [{ at: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    workspace ? db.activityLog.findFirst({ where: { targetWorkspaceId: workspace }, select: { targetWorkspaceName: true } }) : null,
  ]);

  const href = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, filter, workspace, page, ...over })) {
      if (v === undefined || v === "" || (k === "filter" && v === "all") || (k === "page" && v === 1)) continue;
      p.set(k, String(v));
    }
    const s = p.toString();
    return `/activity${s ? `?${s}` : ""}`;
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const tone = { admin: "amber", workspace: "indigo", system: "neutral" } as const;

  return (
    <>
      <div>
        <h1 className="page-title">Activity</h1>
        <p className="page-sub">
          Who did what, across admins and workspaces. This log is append only; nothing here can be edited or deleted.
          {scoped && <> Showing {scoped.targetWorkspaceName}. <Link href="/activity">Show everything</Link></>}
        </p>
      </div>
      <form className="toolbar" action="/activity">
        <input type="search" name="q" defaultValue={q} placeholder="Search actor, workspace or event" aria-label="Search activity" className="input search" />
        {workspace && <input type="hidden" name="workspace" value={workspace} />}
        {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
        <div className="pills">
          {FILTERS.map((f) => (
            <Link key={f.key} href={href({ filter: f.key, page: 1 })} className={`pill${filter === f.key ? " on" : ""}`}>{f.label}</Link>
          ))}
        </div>
      </form>
      <div className="table">
        <div className="trow head" style={{ gridTemplateColumns: COLS }}>
          <div>When</div><div>Actor</div><div>Event</div><div>Workspace</div>
        </div>
        {rows.length === 0 && <div className="empty"><strong>Nothing recorded{q || filter !== "all" ? " that matches" : " yet"}</strong></div>}
        {rows.map((r, i) => (
          <div key={String(r.id)} className={`trow${i % 2 ? " alt" : ""}`} style={{ gridTemplateColumns: COLS, fontSize: 13, padding: "11px 18px" }}>
            <div className="cell-muted" title={r.at.toISOString()}>{when(r.at)}</div>
            <div><span className={`chip sm chip-${tone[r.actorType]}`}>{r.actorType.charAt(0).toUpperCase() + r.actorType.slice(1)}</span></div>
            <div>
              {r.summary}
              {r.reason ? `, reason: ${r.reason}` : ""}
              {(r.before || r.after) && (
                <details style={{ marginTop: 4 }}>
                  <summary className="cell-sub" style={{ cursor: "pointer" }}>Before and after</summary>
                  <pre className="mono" style={{ fontSize: 11.5, whiteSpace: "pre-wrap", margin: "6px 0 0", color: "var(--muted)" }}>
                    {JSON.stringify({ before: r.before, after: r.after }, null, 2)}
                  </pre>
                </details>
              )}
            </div>
            <div>
              {r.targetWorkspaceId ? (
                <Link href={href({ workspace: r.targetWorkspaceId, page: 1 })} className="cell-strong" style={{ textDecoration: "none" }}>{r.targetWorkspaceName}</Link>
              ) : <span className="cell-muted">—</span>}
            </div>
          </div>
        ))}
        <div className="tfoot">
          <span>
            Showing {from} to {to} of {num(total)} · Sensitive actions (Sign in as, plan changes, deletions, goodwill grants) always
            record a typed reason.
          </span>
          <div className="grow" />
          {page > 1 ? <Link className="btn sm" href={href({ page: page - 1 })}>Previous</Link> : <span className="btn sm" aria-disabled="true">Previous</span>}
          {page < pages ? <Link className="btn sm" href={href({ page: page + 1 })}>Next</Link> : <span className="btn sm" aria-disabled="true">Next</span>}
        </div>
      </div>
    </>
  );
}
