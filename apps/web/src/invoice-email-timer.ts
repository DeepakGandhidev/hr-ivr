import { adminPrisma } from "@pratibha/prisma";
import { notifyInvoiceIssued } from "@/lib/billing-emails";

/**
 * Every 10 minutes: email any invoice paid in the last 3 days that has not
 * been emailed yet.
 *
 * The portal emails its own invoices the moment they are paid; this catches
 * the ones raised elsewhere (an admin recording a payment by hand, a pack
 * added from the admin panel) and any whose email failed for a moment.
 * notifyInvoiceIssued sends at most once per invoice, so overlap is harmless.
 */
const EVERY_MS = 10 * 60 * 1000;
const LOOKBACK_MS = 3 * 86_400_000;

async function sweep() {
  const since = new Date(Date.now() - LOOKBACK_MS);
  const paid = await adminPrisma.invoice.findMany({
    where: { status: "paid", paidAt: { gte: since } },
    select: { id: true },
    take: 200,
  });
  if (!paid.length) return;
  const emailed = new Set(
    (
      await adminPrisma.emailLog.findMany({
        where: { dedupeKey: { in: paid.map((p) => `invoice_issued:${p.id}`) } },
        select: { dedupeKey: true },
      })
    ).map((r) => r.dedupeKey)
  );
  for (const { id } of paid) {
    if (!emailed.has(`invoice_issued:${id}`)) await notifyInvoiceIssued(id);
  }
}

export function startInvoiceEmails() {
  const run = () => void sweep().catch((err) => console.error("[invoice-email] sweep failed", err));
  setTimeout(run, 90_000);
  setInterval(run, EVERY_MS).unref?.();
}
