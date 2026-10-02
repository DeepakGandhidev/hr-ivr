import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { displayPhone, lineHealth, strays } from "@/lib/calls";
import { num, when } from "@/lib/format";
import { BlockToggle, FindCandidateButton } from "./CallActions";

export const dynamic = "force-dynamic";

const COLS = "150px 170px 70px minmax(0, 1fr) 260px";

export default async function CallsPage({ searchParams }: { searchParams: { tab?: string } }) {
  const { admin } = await requireAdminPage();
  const tab = searchParams.tab === "health" ? "health" : "unknown";
  const [rows, health] = await Promise.all([strays(30), lineHealth()]);
  const canBlock = can(admin.role, "calls.block");

  return (
    <>
      <div>
        <h1 className="page-title">Calls</h1>
        <p className="page-sub">
          The telephony line across every workspace. Calls that matched an invite live on each tenant&apos;s own Calls page;
          the strays land here.
        </p>
      </div>
      <div className="tabs">
        <Link href="/calls" className={tab === "unknown" ? "on" : undefined}>Unknown callers · {num(rows.length)}</Link>
        <Link href="/calls?tab=health" className={tab === "health" ? "on" : undefined}>Line health</Link>
      </div>

      {tab === "unknown" ? (
        <div className="table">
          <div className="trow head" style={{ gridTemplateColumns: COLS }}>
            <div>When</div><div>Number</div><div>Tries</div><div>Why it did not match</div><div />
          </div>
          {rows.length === 0 && (
            <div className="empty"><strong>No unknown callers in the last 30 days</strong><span>Every call matched an invitation.</span></div>
          )}
          {rows.map((r, i) => (
            <div key={r.number} className={`trow${i % 2 ? " alt" : ""}`} style={{ gridTemplateColumns: COLS, fontSize: 13 }}>
              <div className="cell-muted">{when(r.at)}</div>
              <div className="mono">{displayPhone(r.number)}</div>
              <div>{r.tries}</div>
              <div>{r.reason}{r.blocked && <span className="chip sm chip-red" style={{ marginLeft: 8 }}>Blocked</span>}</div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                {r.tenant ? (
                  <Link className="btn sm" href={`/workspaces/${r.tenant.id}`}>Open in {r.tenant.name.split(" ")[0]}</Link>
                ) : (
                  <FindCandidateButton number={r.number} />
                )}
                {canBlock && <BlockToggle number={r.number} blocked={r.blocked} tries={r.tries} />}
              </div>
            </div>
          ))}
          <div className="tfoot">
            Unknown callers hear the polite refusal and are never billed to any workspace. Find candidate searches every
            workspace by number, so a typo in an invite can be repaired from here. Blocks stop repeated silent or abusive
            numbers at the line.
          </div>
        </div>
      ) : (
        <div className="table">
          <div className="trow head" style={{ gridTemplateColumns: "180px 120px 160px minmax(0, 1fr) 120px" }}>
            <div>Blocked number</div><div>Refused calls</div><div>Last refused</div><div>Reason</div><div />
          </div>
          {health.blocks.length === 0 && <div className="empty"><strong>No numbers are blocked</strong></div>}
          {health.blocks.map((b) => (
            <div key={b.id} className="trow" style={{ gridTemplateColumns: "180px 120px 160px minmax(0, 1fr) 120px", fontSize: 13 }}>
              <div className="mono">{displayPhone(b.phoneE164)}</div>
              <div>{num(b.hits)}</div>
              <div className="cell-muted">{b.lastHitAt ? when(b.lastHitAt) : "Not since the block"}</div>
              <div>{b.reason}</div>
              <div style={{ textAlign: "right" }}>{canBlock && <BlockToggle number={b.phoneE164} blocked />}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid-3" style={{ gap: 12 }}>
        <div className="kpi">
          <div className="kpi-value sm">Not measured</div>
          <div className="kpi-label">Longest answer wait this week · the telephony provider does not report it yet</div>
        </div>
        <div className="kpi">
          <div className="kpi-value sm">{num(health.dropped)}</div>
          <div className="kpi-label">Calls dropped on the line this week</div>
        </div>
        <div className="kpi">
          <div className="kpi-value sm">{health.hindiShare === null ? "—" : `${health.hindiShare}%`}</div>
          <div className="kpi-label">Calls in Hindi or Hinglish this week</div>
        </div>
      </div>
    </>
  );
}
