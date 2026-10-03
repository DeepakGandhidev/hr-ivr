import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { paymentWhere, type PaymentFilter } from "@/lib/payments-admin";
import { recordActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote everything; neutralise a leading formula character so a spreadsheet
  // never executes a workspace name.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};
const rupees = (paise: number | null | undefined) => (paise === null || paise === undefined ? "" : (paise / 100).toFixed(2));

/** The payments CSV: the one export in scope. Exactly the rows the page's filters show. */
export async function GET(request: NextRequest) {
  try {
    const { admin } = await requireAdmin("payments.export");
    const sp = request.nextUrl.searchParams;
    const filter = (["all", "captured", "failed", "refunded"].includes(sp.get("filter") ?? "") ? sp.get("filter") : "all") as PaymentFilter;
    const where = paymentWhere({ q: sp.get("q") ?? undefined, filter, workspace: sp.get("workspace") ?? undefined });
    const rows = await db.payment.findMany({
      where,
      orderBy: { paidAt: "desc" },
      include: { tenant: { include: { companyProfile: true } }, invoice: true },
    });
    const recorders = await db.adminUser.findMany({ select: { id: true, name: true } });
    const name = (id: string | null) => (id ? recorders.find((r) => r.id === id)?.name ?? id : "System");

    const header = [
      "Date", "Workspace", "GSTIN", "Kind", "For", "Amount (INR, before GST)", "Discount (INR)", "Method", "Status",
      "Invoice", "Taxable (INR)", "CGST (INR)", "SGST (INR)", "IGST (INR)", "Invoice total (INR)", "Place of supply",
      "Reference", "Retry", "Reason", "Recorded by",
    ];
    const lines = rows.map((p) => [
      p.paidAt.toISOString().slice(0, 10),
      p.tenant.name,
      p.tenant.companyProfile?.gstin ?? "",
      p.kind,
      p.description,
      rupees(p.amountPaise),
      rupees(p.discountPaise),
      p.method,
      p.status,
      p.invoice?.number ?? "",
      p.invoice ? rupees(p.invoice.subtotalPaise - p.invoice.discountPaise) : "",
      rupees(p.invoice?.cgstPaise),
      rupees(p.invoice?.sgstPaise),
      rupees(p.invoice?.igstPaise),
      rupees(p.invoice?.totalPaise),
      p.invoice?.placeOfSupply ?? "",
      p.reference ?? "",
      p.retryAt?.toISOString().slice(0, 10) ?? "",
      p.reason ?? "",
      name(p.recordedBy),
    ].map(cell).join(","));

    await recordActivity({
      actor: admin,
      action: "payment.exported",
      summary: `${admin.name} exported ${rows.length} payments to CSV`,
      after: { filter, q: sp.get("q"), workspace: sp.get("workspace"), rows: rows.length },
    });

    return new NextResponse([header.map(cell).join(","), ...lines].join("\r\n") + "\r\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="pratibha-payments-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
