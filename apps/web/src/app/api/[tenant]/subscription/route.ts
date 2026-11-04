import { DATA_CONSEQUENCES } from "@/lib/subscription";
import { NextRequest } from "next/server";
import { Action } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { planView, subscriptionOverview, topUpPacks } from "@/lib/subscription";
import { currentPlans } from "@/lib/pricing";
import { paymentProvider } from "@/lib/payments";
import { cashfreeConfig } from "@/lib/cashfree";
import { syncMandate } from "@/lib/autopay";
import { syncOrder } from "@/lib/checkout";
import { adminPrisma } from "@pratibha/prisma";
import { planEntitlements } from "@/lib/plan-features";

export const runtime = "nodejs";

/**
 * Everything the Subscriptions page shows.
 *
 * Readable by an admin, because seeing how many minutes are left is operational
 * information a hiring manager needs. Every action that changes money is owner
 * only and lives on its own route.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  // Back from the gateway's checkout: ask it directly rather than wait on the
  // webhook, so the page shows the mandate as it now is. Only for a reference
  // that is this workspace's own, which the prefix and the lookup both check.
  const returned = request.nextUrl.searchParams.get("autopay");
  if (returned?.startsWith("prt_") && paymentProvider().name === "cashfree") {
    await withTenantAuth(tenant, Action.billingRead, async (_ctx, tx) =>
      tx.paymentMethod.findFirst({ where: { providerRef: returned, mandateStatus: "pending" }, select: { id: true } })
    )
      .then((pending) => (pending ? syncMandate(returned) : undefined))
      .catch((err) => console.error("[cashfree] mandate status check failed", err));
  }
  // Back from a one-time checkout: settle it now if Cashfree says it is paid.
  const orderId = request.nextUrl.searchParams.get("order_id");
  let checkoutStatus: string | null = null;
  if (orderId && paymentProvider().name === "cashfree") {
    checkoutStatus = await withTenantAuth(tenant, Action.billingRead, async (ctx) =>
      adminPrisma.checkoutOrder.findFirst({ where: { orderId, tenantId: ctx.tenant.id }, select: { status: true } })
    )
      .then(async (order) => (order ? (order.status === "pending" ? syncOrder(orderId) : order.status) : null))
      .catch((err) => {
        console.error("[cashfree] order status check failed", err);
        return null;
      });
  }
  return handleApi(() =>
    withTenantAuth(tenant, Action.billingRead, async (ctx, tx) => {
      const overview = await subscriptionOverview(tx, ctx.tenant);

      const [methods, invoices, profile, plans, packs] = await Promise.all([
        tx.paymentMethod.findMany({
          where: { subscriptionId: overview.subscription.id },
          orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
          // Never the provider reference: it is the gateway's handle, useless
          // to the browser and not something to hand out.
          select: {
            id: true,
            provider: true,
            brand: true,
            last4: true,
            mandateStatus: true,
            isDefault: true,
            createdAt: true,
          },
        }),
        tx.invoice.findMany({
          where: { subscriptionId: overview.subscription.id },
          orderBy: { issuedAt: "desc" },
          take: 50,
          select: {
            id: true,
            number: true,
            status: true,
            issuedAt: true,
            periodStart: true,
            periodEnd: true,
            totalPaise: true,
          },
        }),
        // Billing details come from Company profile so there is one source of
        // truth; this page shows them and links there to edit.
        tx.companyProfile.findUnique({
          where: { tenantId: ctx.tenant.id },
          select: { legalName: true, billingAddress: true, billingState: true, gstin: true },
        }),
        // What is on sale, as published in the admin panel.
        currentPlans(tx, { publicOnly: true }),
        topUpPacks(tx),
      ]);

      const provider = paymentProvider();

      return {
        ...overview,
        methods,
        invoices,
        billingDetails: profile,
        topUpPacks: packs,
        // Keyed by plan key: choosing one moves the workspace to that plan's
        // newest published version.
        plans: plans.map((p) => ({
          ...planView(p),
          id: p.key,
          // Every catalogue feature and limit this plan includes (limits null
          // is unlimited), from the admin panel's Plans page.
          entitlements: planEntitlements({ status: "active", planId: p.id, plan: p, trial: null }),
        })),
        // What this workspace has now, the trial's allowances included.
        entitlements: planEntitlements(ctx.tenant),
        // The UI says "no gateway configured" rather than offering a button
        // that cannot work.
        gateway: {
          name: provider.name,
          canCharge: provider.canCharge,
          // Which Cashfree checkout the browser opens; null for other providers.
          mode: provider.name === "cashfree" ? cashfreeConfig()?.mode ?? null : null,
        },
        // Whether this viewer may act, so the page can explain rather than
        // simply fail. The server checks again on every action regardless.
        canManage: ctx.user.role === "owner",
        retentionDays: DATA_CONSEQUENCES.deletedAfterDays,
        // The owner's own number, prefilled so they type it once.
        billingPhone: ctx.user.role === "owner" ? overview.subscription.billingPhone : null,
        // The outcome of a checkout they have just come back from.
        checkoutStatus,
      };
    })
  );
}
