import { NextRequest, NextResponse } from "next/server";
import { Action, ValidationError, writeAuditLog } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { getOrCreateSubscription, planComparison } from "@/lib/subscription";
import { currentUsagePeriod } from "@/lib/billing";
import { currentPlan } from "@/lib/pricing";
import { paymentProvider } from "@/lib/payments";
import { issueInvoice, nextPeriodEnd } from "@/lib/autopay";
import { billingPhone, proratedUpgradePaise, startCheckout } from "@/lib/checkout";
import { notifyPlanChanged } from "@/lib/billing-emails";
import { adminPrisma } from "@pratibha/prisma";
import { z } from "zod";

export const runtime = "nodejs";

const planSchema = z.object({
  /** The plan to move to, by key (starter, growth, scale). It lands on that plan's newest published version. */
  planId: z.string().min(1),
  /** Preview the change without making it. */
  preview: z.boolean().optional(),
  /** For Cashfree's checkout, when none is on file yet. */
  phone: z.string().max(20).optional(),
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

    // With Cashfree connected, buying a plan from the trial, or upgrading,
    // is paid on Cashfree's page first; the plan moves when the payment lands.
    // A trial pays the full month and starts its period then; an upgrade pays
    // the price difference for what is left of the current period. Downgrades
    // fall through to the immediate change below, and the next renewal charges
    // the lower price.
    if (paymentProvider().name === "cashfree" && !parsed.data.preview) {
      const asRow = await adminPrisma.plan.findUnique({ where: { id: parsed.data.planId } });
      const target = await currentPlan(asRow?.key ?? parsed.data.planId);
      if (!target || target.visibility !== "public") throw new ValidationError("Unknown plan");
      const onTrial = ctx.tenant.status === "trial";
      const upgrade = !onTrial && target.priceInr > (ctx.tenant.plan?.priceInr ?? 0);

      if (onTrial || upgrade) {
        const sub = await tx((db) => getOrCreateSubscription(db, ctx.tenant));
        const now = new Date();
        const subtotal = onTrial
          ? target.priceInr * 100
          : proratedUpgradePaise(ctx.tenant.plan.priceInr, target.priceInr, { start: sub.periodStart, end: sub.periodEnd }, now);

        if (subtotal >= 100) {
          const phone = await billingPhone(ctx.tenant.id, parsed.data.phone);
          if (!phone) throw new ValidationError("Enter your mobile number to pay.", { code: "PHONE_REQUIRED" });
          const invoice = await adminPrisma.$transaction((db) =>
            issueInvoice(
              db,
              ctx.tenant,
              sub,
              {
                description: onTrial
                  ? `${target.name} plan, monthly`
                  : `Upgrade to ${target.name} for the rest of this period`,
                unitPaise: subtotal,
              },
              onTrial ? { start: now, end: nextPeriodEnd(now) } : { start: sub.periodStart, end: sub.periodEnd }
            )
          );
          const checkout = await startCheckout({
            tenantId: ctx.tenant.id,
            tenantSlug: tenant,
            customer: { email: ctx.user.email, name: ctx.user.name, phone },
            invoice,
            purpose: "plan_change",
            planId: target.id,
          });
          return NextResponse.json({ checkout, invoice: { number: invoice.number, totalPaise: invoice.totalPaise } });
        }
      }
    }

    // Set once the change is written; the email goes after the commit.
    let changed = null as { fromPlanId: string | null; toPlanId: string } | null;

    const response = await tx(async (db) => {
      const subscription = await getOrCreateSubscription(db, ctx.tenant);

      const meter = await db.usageMeter.findUnique({
        where: { tenantId_period: { tenantId: ctx.tenant.id, period: currentUsagePeriod() } },
        select: { interviewMinutesUsed: true },
      });
      const minutesUsed = meter?.interviewMinutesUsed ?? 0;

      // By key, onto the newest published version: a plan change takes today's
      // price, which is how a grandfathered workspace leaves its old one.
      const asRow = await db.plan.findUnique({ where: { id: parsed.data.planId } });
      const target = await currentPlan(asRow?.key ?? parsed.data.planId, db);
      if (!target || target.visibility !== "public") throw new ValidationError("Unknown plan");

      const comparison = planComparison(ctx.tenant.plan, target, minutesUsed);
      if (!comparison) throw new ValidationError("Unknown plan");

      // A preview changes nothing. The page uses it to show what a downgrade
      // would cost them before they commit to it.
      if (parsed.data.preview) {
        return NextResponse.json({ preview: comparison });
      }

      if (ctx.tenant.planId === target.id) {
        throw new ValidationError("You are already on that plan.");
      }

      const updated = await db.subscription.update({
        where: { id: subscription.id },
        data: { planId: target.id },
      });

      // Tenant.planId is what every quota check reads, so both move together.
      // Leaving them to diverge would mean the page showing one plan while
      // limits enforced another.
      await db.tenant.update({
        where: { id: ctx.tenant.id },
        data: { planId: target.id },
      });

      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "subscription.plan_changed",
        entity: "subscription",
        entityId: subscription.id,
        before: { planId: ctx.tenant.planId, plan: ctx.tenant.plan?.name, priceInr: ctx.tenant.plan?.priceInr },
        after: { planId: target.id, plan: target.name, priceInr: target.priceInr, direction: comparison.direction },
        reason: comparison.alreadyOverTarget
          ? `Already used ${minutesUsed} minutes this period, above the new plan's allowance`
          : undefined,
      });

      changed = { fromPlanId: ctx.tenant.status === "trial" ? null : ctx.tenant.planId, toPlanId: target.id };
      return NextResponse.json({
        subscription: updated,
        comparison,
        // Said plainly rather than implied by silence.
        note: "Your plan has been updated. Billing for the change will be actioned by the Pratibha team.",
      });
    });

    if (changed) await notifyPlanChanged({ tenantId: ctx.tenant.id, ...changed });
    return response;
  });
}
