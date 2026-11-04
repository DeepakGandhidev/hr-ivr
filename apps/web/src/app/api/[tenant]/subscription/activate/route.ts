import { appUrl as publicAppUrlFor } from "@/lib/app-url";
import { setting } from "@pratibha/shared/settings-runtime";
import { NextRequest, NextResponse } from "next/server";
import { adminPrisma } from "@pratibha/prisma";
import { Action, ValidationError, writeAuditLog } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { currentPlan } from "@/lib/pricing";
import { paymentProvider } from "@/lib/payments";
import { cashfreeConfig } from "@/lib/cashfree";
import { ACTIVATION_PREFIX, issueInvoice, mandateMaxPaise, nextPeriodEnd, syncMandate } from "@/lib/autopay";
import { z } from "zod";

export const runtime = "nodejs";

const activateSchema = z.object({
  plan: z.enum(["starter", "growth", "scale"]),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, "").replace(/^(\+91|91)(?=\d{10}$)/, ""))
    .pipe(z.string().regex(/^[6-9]\d{9}$/, "Enter a 10 digit mobile number")),
});

/**
 * Paid signup: pay the first month and set up AutoPay in one Cashfree checkout.
 *
 * The first month's invoice is issued here and parked in renewalInvoiceId, so
 * the existing settlement path pays it, starts the period and activates the
 * workspace once Cashfree confirms the authorisation, which is what collects it.
 * A second attempt (a failed UPI approval, a change of plan) reuses the
 * invoice when the amount still matches and voids it when it does not.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = activateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Choose a plan", parsed.error.flatten());
    }

    const provider = paymentProvider();
    if (!provider.canCharge) throw new ValidationError(`Payments are not available right now. Write to ${setting<string>("brand.support_email")}.`);

    const { ctx } = await authorizeTenant(tenant, Action.billingManage);
    if (ctx.tenant.status !== "pending_payment") {
      throw new ValidationError("This workspace is already active.");
    }

    const plan = await currentPlan(parsed.data.plan);
    if (!plan || plan.visibility !== "public") throw new ValidationError("That plan is not available.");

    // Billing-only work with no session-scoped reads left, so on the admin
    // connection, pinned to this tenant throughout.
    const { invoice, subscriptionId } = await adminPrisma.$transaction(async (db) => {
      const now = new Date();
      let sub = await db.subscription.findUnique({ where: { tenantId: ctx.tenant.id } });
      if (!sub) {
        sub = await db.subscription.create({
          data: { tenantId: ctx.tenant.id, planId: plan.id, status: "past_due", periodStart: now, periodEnd: nextPeriodEnd(now) },
        });
      }
      await db.tenant.update({ where: { id: ctx.tenant.id }, data: { planId: plan.id } });
      sub = await db.subscription.update({
        where: { id: sub.id },
        data: { planId: plan.id, periodStart: now, periodEnd: nextPeriodEnd(now), billingPhone: parsed.data.phone },
      });

      const expectedSubtotal = plan.priceInr * 100;
      const existing = sub.renewalInvoiceId ? await db.invoice.findUnique({ where: { id: sub.renewalInvoiceId } }) : null;
      if (existing && existing.status === "issued" && existing.subtotalPaise === expectedSubtotal) {
        return { invoice: existing, subscriptionId: sub.id };
      }
      if (existing && existing.status === "issued") {
        await db.invoice.update({ where: { id: existing.id }, data: { status: "void" } });
      }

      const fresh = await issueInvoice(
        db,
        { ...ctx.tenant, planId: plan.id },
        sub,
        { description: `${plan.name} plan, monthly`, unitPaise: expectedSubtotal },
        { start: now, end: nextPeriodEnd(now) }
      );
      await db.subscription.update({ where: { id: sub.id }, data: { renewalInvoiceId: fresh.id } });
      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "subscription.activation_started",
        entity: "subscription",
        entityId: sub.id,
        after: { plan: plan.key, invoice: fresh.number, totalPaise: fresh.totalPaise, voided: existing?.number },
      });
      return { invoice: fresh, subscriptionId: sub.id };
    });

    const reference = `${ACTIVATION_PREFIX}${subscriptionId}_${Date.now()}`;
    const appUrl = publicAppUrlFor(request.nextUrl.origin);
    const setup = await provider.createMandate({
      tenantId: ctx.tenant.id,
      customerEmail: ctx.user.email,
      customerName: ctx.user.name ?? undefined,
      customerPhone: parsed.data.phone,
      reference,
      returnUrl: `${appUrl}/${tenant}?autopay=${encodeURIComponent(reference)}`,
      maxAmountPaise: mandateMaxPaise(),
      firstChargePaise: invoice.totalPaise,
    });

    await adminPrisma.paymentMethod.create({
      data: { subscriptionId, provider: provider.name, providerRef: setup.reference, mandateStatus: "pending" },
    });

    return NextResponse.json({
      sessionId: setup.sessionId ?? null,
      redirectUrl: setup.redirectUrl,
      mode: cashfreeConfig()?.mode ?? "sandbox",
      totalPaise: invoice.totalPaise,
    });
  });
}

/**
 * Back from checkout: ask Cashfree how the authorisation went, so the screen
 * can let them in without waiting on the webhook.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const { ctx } = await authorizeTenant(tenant, Action.billingRead);
    const ref = request.nextUrl.searchParams.get("ref");
    if (ref?.startsWith(ACTIVATION_PREFIX) && ctx.tenant.status === "pending_payment") {
      const method = await adminPrisma.paymentMethod.findFirst({
        where: { providerRef: ref, subscription: { tenantId: ctx.tenant.id } },
        select: { id: true },
      });
      if (method) {
        await syncMandate(ref).catch((err) => console.error("[cashfree] activation status check failed", err));
      }
    }
    const fresh = await adminPrisma.tenant.findUnique({ where: { id: ctx.tenant.id }, select: { status: true } });
    const latest = await adminPrisma.paymentMethod.findFirst({
      where: { subscription: { tenantId: ctx.tenant.id }, providerRef: { startsWith: ACTIVATION_PREFIX } },
      orderBy: { createdAt: "desc" },
      select: { mandateStatus: true },
    });
    return NextResponse.json({ status: fresh?.status, lastAttempt: latest?.mandateStatus ?? null });
  });
}
