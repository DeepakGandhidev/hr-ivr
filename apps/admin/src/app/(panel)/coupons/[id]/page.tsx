import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { describeCoupon, effectiveStatus } from "@/lib/coupons";
import { inrPaise, num, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const COLS = "minmax(0, 1fr) 140px 140px 140px 140px";

export default async function CouponRedemptionsPage({ params }: { params: { id: string } }) {
  await requireAdminPage();
  const coupon = await db.coupon.findUnique({
    where: { id: params.id },
    include: {
      redemptions: {
        orderBy: { redeemedAt: "desc" },
        include: { subscription: { include: { tenant: { select: { id: true, name: true } } } }, payment: { include: { invoice: { select: { id: true, number: true } } } } },
      },
    },
  });
  if (!coupon) notFound();
  const status = effectiveStatus(coupon);

  return (
    <>
      <Link href="/coupons" className="back">← Coupons</Link>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title mono">{coupon.code}</h1>
          <p className="page-sub">
            {describeCoupon(coupon)} · {num(coupon.redeemedCount)} of {coupon.maxRedemptions ?? "no cap"} redeemed · {status}
          </p>
        </div>
      </div>
      <div className="table">
        <div className="trow head" style={{ gridTemplateColumns: COLS }}>
          <div>Workspace</div><div>Redeemed</div><div>Discount</div><div>They paid</div><div>Invoice</div>
        </div>
        {coupon.redemptions.length === 0 && <div className="empty"><strong>No redemptions yet</strong></div>}
        {coupon.redemptions.map((r) => (
          <div key={r.id} className="trow" style={{ gridTemplateColumns: COLS }}>
            <Link href={`/workspaces/${r.subscription.tenant.id}`} className="cell-strong" style={{ textDecoration: "none" }}>{r.subscription.tenant.name}</Link>
            <div className="cell-muted">{shortDate(r.redeemedAt)}</div>
            <div style={{ fontSize: 13 }}>{r.discountPaise ? inrPaise(r.discountPaise) : "On the next invoice"}</div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{r.payment ? inrPaise(r.payment.amountPaise) : "—"}</div>
            <div>{r.payment?.invoice ? <Link href={`/payments/invoices/${r.payment.invoice.id}`} style={{ fontWeight: 600 }}>{r.payment.invoice.number}</Link> : <span className="cell-muted">—</span>}</div>
          </div>
        ))}
        <div className="tfoot">Redeemed in the portal before a payment shows “On the next invoice” until the payment is recorded with the code.</div>
      </div>
    </>
  );
}
