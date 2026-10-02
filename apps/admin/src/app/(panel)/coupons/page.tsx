import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { currentPlans } from "@/lib/pricing";
import { describeCoupon, effectiveStatus } from "@/lib/coupons";
import { longDate, num, shortDate } from "@/lib/format";
import { CouponMenu, CreateCouponButton } from "./CouponActions";

export const dynamic = "force-dynamic";

const COLS = "150px minmax(0, 1fr) 140px 130px 130px 140px 40px";
const TONE: Record<string, string> = { active: "green", scheduled: "neutral", draft: "neutral", paused: "amber", ended: "neutral" };

export default async function CouponsPage() {
  const { admin } = await requireAdminPage();
  const [coupons, plans] = await Promise.all([db.coupon.findMany({ orderBy: { createdAt: "desc" } }), currentPlans()]);
  const canManage = can(admin.role, "coupons.manage");
  const planName = (k: string) => plans.find((p) => p.key === k)?.name ?? k;

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Coupons</h1>
          <p className="page-sub">Discounts applied at checkout. A coupon changes the first charge, never the plan&apos;s listed price.</p>
        </div>
        {canManage && <CreateCouponButton plans={plans.map((p) => ({ key: p.key, name: p.name }))} />}
      </div>

      <div className="table">
        <div className="trow head" style={{ gridTemplateColumns: COLS }}>
          <div>Code</div><div>What it does</div><div>Applies to</div><div>Redemptions</div><div>Expires</div><div>Status</div><div />
        </div>
        {coupons.length === 0 && (
          <div className="empty">
            <strong>No coupons yet</strong>
            <span>Create one for a campaign; it can be scheduled to start on a date.</span>
          </div>
        )}
        {coupons.map((c) => {
          const status = effectiveStatus(c);
          const ended = status === "ended";
          const label = status === "scheduled" && c.startsAt ? `Scheduled ${shortDate(c.startsAt)}` : status.charAt(0).toUpperCase() + status.slice(1);
          return (
            <div key={c.id} className={`trow${ended ? " dim" : ""}`} style={{ gridTemplateColumns: COLS }}>
              <Link href={`/coupons/${c.id}`} className="mono" style={{ fontWeight: 700, color: ended ? "var(--faint)" : "var(--ink-strong)", textDecoration: "none" }}>{c.code}</Link>
              <div style={{ fontSize: 13 }}>{describeCoupon(c)}</div>
              <div className="cell-muted" style={{ fontSize: 13 }}>{c.applicablePlans.length ? c.applicablePlans.map(planName).join(", ") : "All plans"}</div>
              <div style={{ fontSize: 13 }}>{num(c.redeemedCount)} of {c.maxRedemptions === null ? "no cap" : num(c.maxRedemptions)}</div>
              <div className="cell-muted" style={{ fontSize: 13 }}>
                {ended ? `Ended ${shortDate(c.endedAt ?? c.expiresAt)}` : c.expiresAt ? longDate(c.expiresAt) : "No expiry"}
              </div>
              <div><span className={`chip chip-${TONE[status]}`}>{label}</span></div>
              {canManage ? (
                <CouponMenu coupon={{ id: c.id, code: c.code, status, cap: c.maxRedemptions, redeemed: c.redeemedCount, expiresAt: c.expiresAt?.toISOString().slice(0, 10) ?? null }} />
              ) : <div />}
            </div>
          );
        })}
        <div className="tfoot">
          A redemption row lists which workspace used the code and what they paid. The menu holds Pause, Edit caps, See
          redemptions, End now. Codes are never reused once ended.
        </div>
      </div>
    </>
  );
}
