import { NextRequest, NextResponse } from "next/server";
import { Action, ValidationError, writeAuditLog } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import {
  getOrCreateSubscription,
  daysRemaining,
  CANCEL_REASONS,
  DATA_CONSEQUENCES,
} from "@/lib/subscription";
import { z } from "zod";

export const runtime = "nodejs";

const cancelSchema = z.object({
  reason: z.enum(CANCEL_REASONS.map((r) => r.key) as [string, ...string[]]),
  comment: z.string().trim().max(2000).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const { ctx, tx } = await authorizeTenant(tenant, Action.billingRead);

    return tx(async (db) => {
      const subscription = await getOrCreateSubscription(db, ctx.tenant);

      return {
        reasons: CANCEL_REASONS,
        consequences: DATA_CONSEQUENCES,
        // The date things actually change, so the dialog can say it rather than
        // leaving the customer to work it out from "end of period".
        accessUntil: subscription.periodEnd,
        daysRemaining: daysRemaining(subscription.periodEnd),
        cancelRequestedAt: subscription.cancelRequestedAt,
      };
    });
  });
}

/**
 * Cancel at the end of the period.
 *
 * Not immediately: they paid for the period, and ending access the moment they
 * click would be taking something they already bought. `cancelRequestedAt` marks
 * the intent; `periodEnd` is when it takes effect.
 *
 * Owner only, and the reason is required — Gaurav asked for it to be stored,
 * and a cancellation with no reason is the one we learn nothing from.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = cancelSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Tell us why you are cancelling", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.billingManage);

    return tx(async (db) => {
      const subscription = await getOrCreateSubscription(db, ctx.tenant);

      if (subscription.cancelRequestedAt) {
        throw new ValidationError("This subscription is already scheduled to end.");
      }

      const updated = await db.subscription.update({
        where: { id: subscription.id },
        data: {
          status: "cancelling",
          cancelRequestedAt: new Date(),
          cancelReason: parsed.data.reason,
          cancelComment: parsed.data.comment ?? null,
        },
      });

      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "subscription.cancelled",
        entity: "subscription",
        entityId: subscription.id,
        before: { status: subscription.status },
        after: {
          status: "cancelling",
          effectiveAt: subscription.periodEnd,
          reason: parsed.data.reason,
        },
        reason: parsed.data.comment,
      });

      return NextResponse.json({
        subscription: updated,
        accessUntil: subscription.periodEnd,
        consequences: DATA_CONSEQUENCES,
      });
    });
  });
}

/** Change their mind. Available right up to the period ending. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const { ctx, tx } = await authorizeTenant(tenant, Action.billingManage);

    return tx(async (db) => {
      const subscription = await getOrCreateSubscription(db, ctx.tenant);

      const updated = await db.subscription.update({
        where: { id: subscription.id },
        data: {
          status: "active",
          cancelRequestedAt: null,
          // The reason is kept: they told us something true at the time, and it
          // is still worth knowing that they nearly left.
        },
      });

      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "subscription.cancellation_reversed",
        entity: "subscription",
        entityId: subscription.id,
        before: { cancelRequestedAt: subscription.cancelRequestedAt },
        after: { status: "active" },
      });

      return NextResponse.json({ subscription: updated });
    });
  });
}
