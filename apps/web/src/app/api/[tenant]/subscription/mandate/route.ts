import { appUrl as publicAppUrlFor } from "@/lib/app-url";
import { NextRequest, NextResponse } from "next/server";
import { Action, ValidationError, writeAuditLog } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { getOrCreateSubscription } from "@/lib/subscription";
import { paymentProvider } from "@/lib/payments";
import { cashfreeConfig } from "@/lib/cashfree";
import { mandateMaxPaise } from "@/lib/autopay";
import { z } from "zod";

export const runtime = "nodejs";

const setupSchema = z.object({
  /** Indian mobile number; mandate rails send the approval and pre-debit notices to it. */
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, "").replace(/^(\+91|91)(?=\d{10}$)/, ""))
    .pipe(z.string().regex(/^[6-9]\d{9}$/, "Enter a 10 digit mobile number")),
});

/**
 * Begin AutoPay: create the mandate at the gateway and hand the browser the
 * session it opens checkout with.
 *
 * Owner only, like every action that commits the company's money. The method
 * row is written as `pending` before the customer has authorised anything; the
 * webhook (or the status check on return) moves it to active or failed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = setupSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Enter a mobile number", parsed.error.flatten());
    }

    const provider = paymentProvider();
    if (!provider.canCharge) throw new ValidationError("No payment gateway is connected yet.");

    const { ctx, tx } = await authorizeTenant(tenant, Action.billingManage);
    const subscription = await tx((db) => getOrCreateSubscription(db, ctx.tenant));

    // Ours, and unique per attempt: an abandoned checkout leaves a pending row
    // behind, and the next attempt must not collide with it at the gateway.
    const reference = `prt_${subscription.id}_${Date.now()}`;
    const appUrl = publicAppUrlFor(request.nextUrl.origin);

    const setup = await provider.createMandate({
      tenantId: ctx.tenant.id,
      customerEmail: ctx.user.email,
      customerName: ctx.user.name ?? undefined,
      customerPhone: parsed.data.phone,
      reference,
      returnUrl: `${appUrl}/${tenant}/settings/subscription?autopay=${encodeURIComponent(reference)}`,
      maxAmountPaise: mandateMaxPaise(),
    });

    await tx(async (db) => {
      await db.subscription.update({ where: { id: subscription.id }, data: { billingPhone: parsed.data.phone } });
      const method = await db.paymentMethod.create({
        data: {
          subscriptionId: subscription.id,
          provider: provider.name,
          providerRef: setup.reference,
          mandateStatus: "pending",
        },
      });
      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "payment_method.mandate_requested",
        entity: "payment_method",
        entityId: method.id,
        after: { provider: provider.name, maxAmountPaise: mandateMaxPaise() },
      });
    });

    return NextResponse.json({
      sessionId: setup.sessionId ?? null,
      redirectUrl: setup.redirectUrl,
      mode: cashfreeConfig()?.mode ?? "sandbox",
    });
  });
}

const revokeSchema = z.object({ methodId: z.string().min(1) });

/**
 * Turn AutoPay off. The mandate is cancelled at the gateway first, so a row
 * marked revoked here can never still be debited there.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = revokeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Choose a payment method");

    const { ctx, tx } = await authorizeTenant(tenant, Action.billingManage);
    const method = await tx(async (db) => {
      const subscription = await getOrCreateSubscription(db, ctx.tenant);
      return db.paymentMethod.findFirst({ where: { id: parsed.data.methodId, subscriptionId: subscription.id } });
    });
    if (!method) throw new ValidationError("That payment method is not on this workspace.");

    if (method.provider === "cashfree" && method.mandateStatus !== "revoked") {
      await paymentProvider().revokeMandate(method.providerRef);
    }

    await tx(async (db) => {
      await db.paymentMethod.update({ where: { id: method.id }, data: { mandateStatus: "revoked", isDefault: false } });
      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "payment_method.mandate_revoked",
        entity: "payment_method",
        entityId: method.id,
        before: { mandateStatus: method.mandateStatus },
        after: { mandateStatus: "revoked" },
      });
    });

    return NextResponse.json({ note: "AutoPay is off. Renewals will be invoiced for you to settle." });
  });
}
