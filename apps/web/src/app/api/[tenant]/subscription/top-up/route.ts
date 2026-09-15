import { NextRequest, NextResponse } from "next/server";
import {
  Action,
  ValidationError,
  writeAuditLog,
  calculateInvoice,
  nextInvoiceNumber,
  financialYear,
} from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { Prisma } from "@pratibha/prisma";
import { handleApi } from "@/lib/api-errors";
import { getOrCreateSubscription, TOP_UP_PACKS } from "@/lib/subscription";
import { paymentProvider, sellerIdentity } from "@/lib/payments";
import { z } from "zod";

export const runtime = "nodejs";

const topUpSchema = z.object({
  minutes: z.number().int().positive(),
});

/**
 * Buy a pack of interview minutes.
 *
 * Packs only, not an arbitrary quantity: the price per minute differs by pack,
 * so accepting any number would mean inventing a rate for it. The requested
 * size is matched against the published packs and anything else is refused.
 *
 * An invoice is raised whether or not a gateway can take the money. The minutes
 * are granted either way, and the invoice is marked `issued` rather than `paid`,
 * so what is owed is on record and reconcilable — a top-up that silently granted
 * minutes with no invoice is revenue nobody can find.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = topUpSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Choose a top-up pack", parsed.error.flatten());
    }

    const pack = TOP_UP_PACKS.find((p) => p.minutes === parsed.data.minutes);
    if (!pack) throw new ValidationError("That top-up pack is not available.");

    const { ctx, tx } = await authorizeTenant(tenant, Action.billingManage);
    const seller = sellerIdentity();
    const provider = paymentProvider();

    return tx(async (db) => {
      const subscription = await getOrCreateSubscription(db, ctx.tenant);

      const profile = await db.companyProfile.findUnique({
        where: { tenantId: ctx.tenant.id },
        select: { legalName: true, billingAddress: true, billingState: true, gstin: true },
      });

      const totals = calculateInvoice({
        lines: [
          {
            description: `${pack.minutes} interview minutes (top-up)`,
            quantity: pack.minutes,
            unitPaise: Math.round(pack.pricePaise / pack.minutes),
          },
        ],
        sellerState: seller.state,
        buyerState: profile?.billingState,
      });

      const issuedAt = new Date();

      // Counted inside this transaction so two simultaneous top-ups cannot take
      // the same number. A gap in the series is a question an auditor asks.
      const yearPrefix = `${seller.invoicePrefix}/${financialYear(issuedAt)}/`;
      const issuedThisYear = await db.invoice.count({
        where: { number: { startsWith: yearPrefix } },
      });

      const invoice = await db.invoice.create({
        data: {
          subscriptionId: subscription.id,
          number: nextInvoiceNumber(seller.invoicePrefix, issuedAt, issuedThisYear),
          status: "issued",
          periodStart: subscription.periodStart,
          periodEnd: subscription.periodEnd,
          issuedAt,
          // Cast because Prisma's Json input type does not accept a typed
          // array directly; the shape is the InvoiceLine contract either way.
          lines: totals.lines as unknown as Prisma.InputJsonValue,
          subtotalPaise: totals.subtotalPaise,
          discountPaise: totals.discountPaise,
          cgstPaise: totals.tax.cgstPaise,
          sgstPaise: totals.tax.sgstPaise,
          igstPaise: totals.tax.igstPaise,
          totalPaise: totals.totalPaise,
          placeOfSupply: profile?.billingState ?? "Unknown",
          // Snapshotted, not joined: an invoice records what was true when it
          // was issued, and must not change if either party's details do.
          seller: { ...seller },
          buyer: {
            legalName: profile?.legalName ?? ctx.tenant.name,
            address: profile?.billingAddress ?? null,
            state: profile?.billingState ?? null,
            gstin: profile?.gstin ?? null,
          },
        },
        select: { id: true, number: true, totalPaise: true, status: true },
      });

      await db.subscription.update({
        where: { id: subscription.id },
        data: { topUpMinutes: { increment: pack.minutes } },
      });

      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "subscription.top_up_purchased",
        entity: "subscription",
        entityId: subscription.id,
        after: { minutes: pack.minutes, invoice: invoice.number, totalPaise: invoice.totalPaise },
      });

      return NextResponse.json({
        invoice,
        minutesAdded: pack.minutes,
        // Honest about what did and did not happen.
        paid: false,
        note: provider.canCharge
          ? "Your minutes are available now. The payment will be taken against your mandate."
          : "Your minutes are available now. The invoice will be settled with the Pratibha team.",
      });
    });
  });
}
