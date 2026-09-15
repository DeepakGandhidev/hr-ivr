import { NextRequest, NextResponse } from "next/server";
import { Action, PLANS, ValidationError, writeAuditLog } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { getOrCreateSubscription, planComparison } from "@/lib/subscription";
import { currentUsagePeriod } from "@/lib/billing";
import { z } from "zod";

export const runtime = "nodejs";

const planSchema = z.object({
  planId: z.enum(Object.keys(PLANS) as [string, ...string[]]),
  /** Preview the change without making it. */
  preview: z.boolean().optional(),
});

/**
 * Change the plan.
 *
 * Owner only: this commits the company to a different monthly figure, and an
 * admin is not the account holder. Enforced here from the session, never from
 * anything the browser sent.
 *
 * With no gateway wired the change is recorded and applied, and the team
 * actions the money side manually — the agreed interim. The audit entry is what
 * makes that reconcilable, so it records the direction and both plans rather
 * than just the new one.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = planSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Invalid plan change", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.billingManage);

    return tx(async (db) => {
      const subscription = await getOrCreateSubscription(db, ctx.tenant);

      const meter = await db.usageMeter.findUnique({
        where: { tenantId_period: { tenantId: ctx.tenant.id, period: currentUsagePeriod() } },
        select: { interviewMinutesUsed: true },
      });
      const minutesUsed = meter?.interviewMinutesUsed ?? 0;

      const comparison = planComparison(subscription.planId, parsed.data.planId, minutesUsed);
      if (!comparison) throw new ValidationError("Unknown plan");

      // A preview changes nothing. The page uses it to show what a downgrade
      // would cost them before they commit to it.
      if (parsed.data.preview) {
        return NextResponse.json({ preview: comparison });
      }

      if (subscription.planId === parsed.data.planId) {
        throw new ValidationError("You are already on that plan.");
      }

      const updated = await db.subscription.update({
        where: { id: subscription.id },
        data: { planId: parsed.data.planId },
      });

      // Tenant.planId is what every quota check reads, so both move together.
      // Leaving them to diverge would mean the page showing one plan while
      // limits enforced another.
      await db.tenant.update({
        where: { id: ctx.tenant.id },
        data: { planId: parsed.data.planId },
      });

      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "subscription.plan_changed",
        entity: "subscription",
        entityId: subscription.id,
        before: { planId: subscription.planId },
        after: { planId: parsed.data.planId, direction: comparison.direction },
        reason: comparison.alreadyOverTarget
          ? `Already used ${minutesUsed} minutes this period, above the new plan's allowance`
          : undefined,
      });

      return NextResponse.json({
        subscription: updated,
        comparison,
        // Said plainly rather than implied by silence.
        note: "Your plan has been updated. Billing for the change will be actioned by the Pratibha team.",
      });
    });
  });
}
