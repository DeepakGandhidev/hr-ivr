import { NextRequest } from "next/server";
import { Action, PLANS } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { subscriptionOverview, TOP_UP_PACKS } from "@/lib/subscription";
import { paymentProvider } from "@/lib/payments";

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
  return handleApi(() =>
    withTenantAuth(tenant, Action.billingRead, async (ctx, tx) => {
      const overview = await subscriptionOverview(tx, ctx.tenant);

      const [methods, invoices, profile] = await Promise.all([
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
      ]);

      const provider = paymentProvider();

      return {
        ...overview,
        methods,
        invoices,
        billingDetails: profile,
        topUpPacks: TOP_UP_PACKS,
        plans: Object.values(PLANS).map((p) => ({
          id: p.id,
          name: p.name,
          priceInr: p.priceInr,
          limits: p.limits,
        })),
        // The UI says "no gateway configured" rather than offering a button
        // that cannot work.
        gateway: { name: provider.name, canCharge: provider.canCharge },
        // Whether this viewer may act, so the page can explain rather than
        // simply fail. The server checks again on every action regardless.
        canManage: ctx.user.role === "owner",
      };
    })
  );
}
