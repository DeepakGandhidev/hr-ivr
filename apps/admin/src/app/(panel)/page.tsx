import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/session";
import { panelContext } from "@/lib/panel-context";
import { db } from "@/lib/db";
import {
  dropsTrend,
  funnelThisMonth,
  minutesPerDay,
  newPayingThisMonth,
  openFailedPayments,
  platformHealth,
  topUpsThisMonth,
  trialConversion,
  unknownCallersThisWeek,
  usageThisMonth,
  workspaceFigures,
} from "@/lib/metrics";
import { workspaceRows, meterPercent, LISTED } from "@/lib/workspaces";
import { inr, inrPaise, num, shortDate, ago, plural } from "@/lib/format";
import { WorkspaceRowMenu } from "@/components/WorkspaceActions";
import { CreateWorkspaceButton } from "./workspaces/CreateWorkspace";

export const dynamic = "force-dynamic";

const COLS = "minmax(0, 1fr) 90px 150px 120px 80px 40px";

export default async function DashboardPage() {
  const { admin, session } = await requireAdminPage();

  const [ws, usage, newPaying, trials, topUps, failed, strays, perDay, drops, health, activity, newest, ctx, pendingDeletes] =
    await Promise.all([
      workspaceFigures(),
      usageThisMonth(),
      newPayingThisMonth(),
      trialConversion(),
      topUpsThisMonth(),
      openFailedPayments(),
      unknownCallersThisWeek(),
      minutesPerDay(14),
      dropsTrend(),
      platformHealth(),
      db.activityLog.findMany({ orderBy: { at: "desc" }, take: 5 }),
      workspaceRows({ status: { in: LISTED } }, { sort: "newest", take: 5 }),
      panelContext(admin, session),
      db.tenant.findMany({ where: { deletionRequestedBy: { not: null }, status: { not: "deleted_pending" } }, select: { id: true, name: true } }),
    ]);
  const funnel = await funnelThisMonth(usage);

  if (ws.tenants.length === 0) {
    return (
      <>
        <Head />
        <div className="table">
          <div className="empty">
            <strong>No workspaces yet</strong>
            <span>The dashboard fills in as companies sign up. You can also create one by hand.</span>
            {ctx.allowed["workspace.create"] && <CreateWorkspaceButton plans={ctx.plans} />}
          </div>
        </div>
      </>
    );
  }

  const avgMinutes = usage.interviews ? Math.round(usage.minutes / usage.interviews) : 0;
  const maxDay = Math.max(1, ...perDay.series.map((d) => d.minutes));
  const today = perDay.series[perDay.series.length - 1]?.minutes ?? 0;
  const o = usage.outcomes;
  const pct = (n: number) => (usage.calls ? (n / usage.calls) * 100 : 0);
  const mixTotal = Array.from(ws.planMix.values()).reduce((s, p) => s + p.count, 0);
  const mixColors = ["#9C98C2", "#1E1B4B", "#F59E0B", "#56534B"];

  return (
    <>
      <Head />

      <div className="grid-4">
        <Kpi value={inr(ws.mrr)} label={`MRR · ${newPaying.mrr ? `up ${inr(newPaying.mrr)} this month` : "no new MRR this month"}`} />
        <Kpi value={inrPaise(topUps.paise)} label={`Top ups this month · ${plural(topUps.packs, "pack")}`} />
        <Kpi value={num(ws.paying)} label={`Paying workspaces · ${num(newPaying.count)} new`} />
        <Kpi value={num(ws.trials)} label={`Trials · ${trials.rate === null ? "none finished yet" : `${trials.rate}% convert so far`}`} />
        <Kpi value={num(ws.minutesUsed)} label={`Minutes used · of ${num(ws.minutesSold)} sold`} />
        <Kpi value={num(usage.interviews)} label={`Interviews this month${usage.interviews ? ` · ${avgMinutes} min avg` : ""}`} />
        <Kpi value={num(usage.screenings)} label="CV screenings this month" />
        <Kpi
          value={usage.completion === null ? "—" : `${usage.completion}%`}
          warn={usage.completion !== null && usage.completion < 85}
          label={`Call completion${drops.thisWeek > drops.lastWeek ? " · drops rising" : ""}`}
        />
      </div>

      {(ws.outOfMinutes.length > 0 || failed.length > 0 || strays.numbers > 0 || pendingDeletes.length > 0) && (
        <div className="notice attention">
          {ws.outOfMinutes.map((t) => (
            <div key={t.id} className="attention-row">
              <span>{t.name} has used all its minutes; further interviews run as overage until it tops up.</span>
              <Link href={`/workspaces/${t.id}`}>Offer a top up</Link>
            </div>
          ))}
          {failed.map((f) => (
            <div key={f.id} className="attention-row">
              <span>
                {f.tenant.name} has a failed payment
                {f.retryAt ? `; the next retry is ${shortDate(f.retryAt)}` : "; no retry is scheduled"}.
              </span>
              <Link href={`/payments?workspace=${f.tenantId}`}>View payment</Link>
            </div>
          ))}
          {strays.numbers > 0 && (
            <div className="attention-row">
              <span>
                {plural(strays.numbers, "unknown caller")} this week matched no invitation
                {strays.repeated ? `; ${num(strays.repeated)} tried repeatedly` : ""}.
              </span>
              <Link href="/calls">Review the call log</Link>
            </div>
          )}
          {pendingDeletes.map((t) => (
            <div key={t.id} className="attention-row">
              <span>Deleting {t.name} is waiting for a second admin.</span>
              <Link href={`/workspaces/${t.id}`}>Review</Link>
            </div>
          ))}
        </div>
      )}

      <div className="card funnel">
        {[
          ["Applications", funnel.applications],
          ["Screened", funnel.screened],
          ["Shortlisted", funnel.shortlisted],
          ["Interviewed", funnel.interviewed],
          ["Recommended", funnel.recommended],
        ].map(([label, n], i) => (
          <div key={label as string} style={{ display: "contents" }}>
            {i > 0 && (
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="#C9C4B4" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M5 3 L9.5 7 L5 11" />
              </svg>
            )}
            <div className="funnel-step">
              <div className="funnel-num">{num(n as number)}</div>
              <div className="funnel-label">{label}</div>
            </div>
          </div>
        ))}
        <div className="funnel-note">Across every<br />workspace, this month</div>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ flex: 2, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div className="table">
            <div className="trow head" style={{ gridTemplateColumns: COLS }}>
              <div>Workspace</div><div>Plan</div><div>Minutes</div><div>Status</div><div>Joined</div><div />
            </div>
            {newest.map((r) => {
              const p = meterPercent(r.minutesUsed, r.minutesAllowed);
              return (
                <div key={r.id} className={`trow${r.statusChip.label !== "Active" ? " highlight" : ""}`} style={{ gridTemplateColumns: COLS }}>
                  <Link href={`/workspaces/${r.id}`} className="cell-strong" style={{ textDecoration: "none" }}>{r.name}</Link>
                  <div><span className={`chip chip-${r.planChip.tone}`}>{r.planChip.label}</span></div>
                  <div>
                    <div className="meter-label">{num(r.minutesUsed)} of {num(r.minutesAllowed)}</div>
                    <div className={`meter${p >= 100 ? " warn" : ""}`}><div style={{ width: `${p}%` }} /></div>
                  </div>
                  <div><span className={`chip chip-${r.statusChip.tone}`}>{r.statusChip.label}</span></div>
                  <div className="cell-muted">{shortDate(r.createdAt)}</div>
                  <WorkspaceRowMenu ws={{ id: r.id, name: r.name, status: r.status, planKey: r.planKey, planName: r.planName }} ctx={ctx} />
                </div>
              );
            })}
            <div className="tfoot">
              <span>The menu holds Open, Change plan, Add minutes, Sign in as workspace, Suspend. Every Sign in as is logged.</span>
              <div className="grow" />
              <Link href="/workspaces" style={{ fontWeight: 600 }}>All workspaces →</Link>
            </div>
          </div>

          <div className="card card-pad-sm">
            <div className="card-title-sm" style={{ marginBottom: 10 }}>Call outcomes this month · {plural(usage.calls, "call")}</div>
            <div className="stackbar">
              <div style={{ width: `${pct(o.completed)}%`, background: "#166534" }} title="Completed" />
              <div style={{ width: `${pct(o.noShow)}%`, background: "#B45309" }} title="No show" />
              <div style={{ width: `${pct(o.dropped)}%`, background: "#8A3B2B" }} title="Dropped" />
              <div style={{ width: `${pct(o.outOfWindow)}%`, background: "#9C98C2" }} title="Out of window" />
              <div style={{ width: `${pct(o.declinedConsent)}%`, background: "#56534B" }} title="Declined consent" />
            </div>
            <div className="legend">
              <span><b style={{ color: "#166534" }}>{num(o.completed)}</b> completed</span>
              <span><b style={{ color: "#B45309" }}>{num(o.noShow)}</b> no show</span>
              <span><b style={{ color: "#8A3B2B" }}>{num(o.dropped)}</b> dropped</span>
              <span><b>{num(o.outOfWindow)}</b> out of window</span>
              <span><b>{num(o.declinedConsent)}</b> declined consent</span>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div className="card card-pad-sm">
            <div className="card-title-sm" style={{ marginBottom: 10 }}>Interview minutes per day</div>
            <svg viewBox="0 0 280 70" width="100%" height="70" role="img" aria-label="Bar chart of interview minutes per day for the last two weeks">
              {perDay.series.map((d, i) => {
                const h = Math.max(d.minutes ? 3 : 1, Math.round((d.minutes / maxDay) * 66));
                const last = i === perDay.series.length - 1;
                return (
                  <rect key={d.day} x={i * 20} y={70 - h} width="14" height={h} rx="2" fill={last ? "#F59E0B" : "#1E1B4B"}>
                    <title>{`${shortDate(d.day)}: ${num(d.minutes)} minutes`}</title>
                  </rect>
                );
              })}
            </svg>
            <div className="hint" style={{ marginTop: 6 }}>
              {num(today)} today{today > 0 && today >= perDay.allTimeBest ? ", the platform's best day yet." : "."}
            </div>
          </div>

          <div className="card card-pad-sm">
            <div className="card-title-sm" style={{ marginBottom: 10 }}>Plan mix · {num(mixTotal)} paying</div>
            <div className="stackbar">
              {Array.from(ws.planMix.entries()).map(([key, p], i) => (
                <div key={key} style={{ width: `${mixTotal ? (p.count / mixTotal) * 100 : 0}%`, background: mixColors[i % 4] }} title={p.name} />
              ))}
            </div>
            <div className="legend">
              {Array.from(ws.planMix.entries()).map(([key, p]) => (
                <span key={key}><b>{num(p.count)}</b> {p.name}</span>
              ))}
            </div>
          </div>

          <div className="card card-pad-sm">
            <div className="card-title-sm" style={{ marginBottom: 8 }}>Platform health · 7 days</div>
            <div className="feed">
              <div>
                {plural(health.sent, "invitation email")} sent
                {health.bounced ? <> · <span style={{ color: "var(--amber-strong)", fontWeight: 600 }}>{num(health.bounced)} bounced</span></> : " · none bounced"}
              </div>
              <div>{plural(health.failedScreenings, "failed screening")} · {plural(health.reports, "report")} delivered</div>
              <div>{health.dropped ? `${plural(health.dropped, "call")} dropped on the line` : "No calls dropped on the line"}</div>
            </div>
          </div>

          <div className="card card-pad-sm">
            <div className="card-title-sm" style={{ marginBottom: 10 }}>Latest activity</div>
            <div className="feed">
              {activity.map((a) => (
                <div key={String(a.id)}>
                  {a.summary}{a.targetWorkspaceName && !a.summary.includes(a.targetWorkspaceName) ? `, ${a.targetWorkspaceName}` : ""}{" "}
                  <span className="when">· {ago(a.at)}</span>
                </div>
              ))}
            </div>
            <div className="card-foot" style={{ marginTop: 12 }}>
              <Link href="/activity" style={{ fontWeight: 600 }}>Full activity log →</Link>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Head() {
  return (
    <div>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Pratibha across every workspace, and what needs a human today.</p>
    </div>
  );
}

function Kpi({ value, label, warn }: { value: string; label: string; warn?: boolean }) {
  return (
    <div className="kpi">
      <div className={`kpi-value${warn ? " warn" : ""}`}>{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}
