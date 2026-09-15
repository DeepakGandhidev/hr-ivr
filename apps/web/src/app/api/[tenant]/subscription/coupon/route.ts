import { NextRequest, NextResponse } from "next/server";
import { Action, ValidationError, writeAuditLog } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { getOrCreateSubscription } from "@/lib/subscription";
import { z } from "zod";

export const runtime = "nodejs";

const couponSchema = z.object({
  code: z.string().trim().min(1).max(64),
});

/**
 * Redeem a coupon.
 *
 * Every refusal returns the same message. A code that reports "already used" as
 * distinct from "no such code" is an oracle for enumerating live codes, and
 * coupon codes are guessable by design — they are meant to be typed off a slide.
 *
 * A minutes coupon is applied immediately, because minutes are the thing being
 * consumed right now. Percent and amount coupons are recorded and applied to
 * the next invoice, since there is nothing to discount until one is raised.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = couponSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Enter a coupon code");
    }

    const code = parsed.data.code.toUpperCase();
    const { ctx, tx } = await authorizeTenant(tenant, Action.billingManage);

    const refuse = () =>
      NextResponse.json(
        { error: "COUPON_INVALID", message: "That code is not valid." },
        { status: 400 }
      );

    return tx(async (db) => {
      const subscription = await getOrCreateSubscription(db, ctx.tenant);

      const coupon = await db.coupon.findUnique({ where: { code } });
      if (!coupon || !coupon.active) return refuse();
      if (coupon.expiresAt && coupon.expiresAt < new Date()) return refuse();
      if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
        return refuse();
      }

      const already = await db.couponRedemption.findUnique({
        where: {
          couponId_subscriptionId: { couponId: coupon.id, subscriptionId: subscription.id },
        },
      });
      if (already) return refuse();

      await db.couponRedemption.create({
        data: { couponId: coupon.id, subscriptionId: subscription.id },
      });
      await db.coupon.update({
        where: { id: coupon.id },
        data: { redeemedCount: { increment: 1 } },
      });

      let applied: string;
      if (coupon.kind === "minutes") {
        await db.subscription.update({
          where: { id: subscription.id },
          data: { topUpMinutes: { increment: coupon.value } },
        });
        applied = `${coupon.value} interview minutes added.`;
      } else {
        applied =
          coupon.kind === "percent"
            ? `${coupon.value}% off your next invoice.`
            : `₹${(coupon.value / 100).toFixed(2)} off your next invoice.`;
      }

      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "subscription.coupon_redeemed",
        entity: "subscription",
        entityId: subscription.id,
        after: { code, kind: coupon.kind, value: coupon.value },
      });

      return NextResponse.json({ ok: true, message: applied });
    });
  });
}
