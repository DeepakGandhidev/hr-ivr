import { NextRequest, NextResponse } from "next/server";
import {
  Action,
  ValidationError,
  writeAuditLog,
  calculateInvoice,
  nextInvoiceNumber,
  financialYear,
  formatAddress,
} from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { Prisma } from "@pratibha/prisma";
import { handleApi } from "@/lib/api-errors";
import { getOrCreateSubscription } from "@/lib/subscription";
import { livePacks } from "@/lib/pricing";
import { paymentProvider, sellerIdentity } from "@/lib/payments";
import { chargeInvoice, debitDate, issueInvoice } from "@/lib/autopay";
import { billingPhone, startCheckout } from "@/lib/checkout";
import { adminPrisma } from "@pratibha/prisma";
import { z } from "zod";

export const runtime = "nodejs";

const topUpSchema = z
  .object({
    /** A published pack. */
    packId: z.string().min(1).optional(),
    /** The older request shape: a minutes pack by its size. */
    minutes: z.number().int().positive().optional(),
    /** For Cashfree's checkout, when none is on file yet. */
    phone: z.string().max(20).optional(),
  })
  .refine((v) => v.packId || v.minutes, "Choose a top-up pack");

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
 *
 * With Cashfree connected it is paid there and then instead: the invoice is
 * issued, Cashfree's payment page opens, and the pack is added only once the
 * payment lands (lib/checkout.ts).
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

    const { ctx, tx } = await authorizeTenant(tenant, Action.billingManage);

    // Only packs published in the admin panel are on sale.
    const packs = await livePacks();
    const pack = parsed.data.packId
      ? packs.find((p) => p.id === parsed.data.packId)
      : packs.find((p) => p.kind === "minutes" && p.quantity === parsed.data.minutes);
    if (!pack) throw new ValidationError("That top-up pack is not available.");
    const pricePaise = pack.priceInr * 100;
    const unit = pack.kind === "minutes" ? "interview minutes" : "CV screenings";
    const seller = sellerIdentity();
    const provider = paymentProvider();

    if (provider.name === "cashfree") {
      const phone = await billingPhone(ctx.tenant.id, parsed.data.phone);
      if (!phone) throw new ValidationError("Enter your mobile number to pay.", { code: "PHONE_REQUIRED" });
      const invoice = await adminPrisma.$transaction(async (db) => {
        const subscription = await getOrCreateSubscription(db as never, ctx.tenant);
        return issueInvoice(
          db,
          ctx.tenant,
          subscription,
          { description: `${pack.quantity} ${unit} (top-up)`, unitPaise: pricePaise },
          { start: subscription.periodStart, end: subscription.periodEnd }
        );
      });
      const checkout = await startCheckout({
        tenantId: ctx.tenant.id,
        tenantSlug: tenant,
        customer: { email: ctx.user.email, name: ctx.user.name, phone },
        invoice,
        purpose: "top_up",
        packId: pack.id,
      });
      return NextResponse.json({ checkout, invoice: { number: invoice.number, totalPaise: invoice.totalPaise } });
    }

    const result = await tx(async (db) => {
      const subscription = await getOrCreateSubscription(db, ctx.tenant);

      // The same lock every other issuer takes, so numbers stay gapless and unique.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pratibha.invoice_number'))`;

      const profile = await db.companyProfile.findUnique({
        where: { tenantId: ctx.tenant.id },
        select: { legalName: true, billingAddress: true, addressLine: true, city: true, pinCode: true, billingState: true, gstin: true },
      });

      const totals = calculateInvoice({
        lines: [
          {
            description: `${pack.quantity} ${unit} (top-up)`,
            quantity: 1,
            unitPaise: pricePaise,
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
            // The structured address (CP24), falling back to the older single
            // block for a profile nobody has re-saved since.
            address:
              // The state prints on its own line, so it is left out of the block.
          formatAddress({ addressLine: profile?.addressLine, city: profile?.city, pinCode: profile?.pinCode }) ??
              profile?.billingAddress ??
              null,
            state: profile?.billingState ?? null,
            gstin: profile?.gstin ?? null,
          },
        },
        select: { id: true, number: true, totalPaise: true, status: true },
      });

      await db.subscription.update({
        where: { id: subscription.id },
        data:
          pack.kind === "minutes"
            ? { topUpMinutes: { increment: pack.quantity } }
            : { topUpScreenings: { increment: pack.quantity } },
      });

      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "subscription.top_up_purchased",
        entity: "subscription",
        entityId: subscription.id,
        after: { packId: pack.id, kind: pack.kind, quantity: pack.quantity, invoice: invoice.number, totalPaise: invoice.totalPaise },
      });

      return { invoice, subscriptionId: subscription.id };
    });

    // After the commit, outside the transaction: the gateway may be slow, and
    // the minutes and invoice stand whether or not the debit is accepted.
    const charge = provider.canCharge
      ? await chargeInvoice(adminPrisma, result.subscriptionId, result.invoice, debitDate(new Date()))
      : { charged: false };
    if (charge.error) console.error(`[cashfree] top-up charge for ${result.invoice.number} refused: ${charge.error}`);

    return NextResponse.json({
      invoice: result.invoice,
      minutesAdded: pack.kind === "minutes" ? pack.quantity : 0,
      screeningsAdded: pack.kind === "screenings" ? pack.quantity : 0,
      // Honest about what did and did not happen.
      paid: false,
      note: charge.charged
        ? "Your minutes are available now. The payment will be taken by AutoPay after your bank's pre-debit notice."
        : "Your minutes are available now. The invoice will be settled with the Pratibha team.",
    });
  });
}
