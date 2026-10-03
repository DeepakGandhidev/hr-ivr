import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { inrPaise, longDate } from "@/lib/format";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

type Party = { legalName?: string; gstin?: string | null; address?: string | null; state?: string | null; stateCode?: string | null };
type Line = { description: string; hsnSac: string; quantity: number; unitPaise: number; amountPaise: number };

/** One tax invoice, as issued: seller and buyer are the snapshots taken at issue time. */
export default async function InvoicePage({ params }: { params: { id: string } }) {
  await requireAdminPage();
  const inv = await db.invoice.findUnique({
    where: { id: params.id },
    include: { subscription: { include: { tenant: { select: { id: true, name: true } } } }, payment: true },
  });
  if (!inv) notFound();
  const seller = inv.seller as Party;
  const buyer = inv.buyer as Party;
  const lines = inv.lines as unknown as Line[];
  const taxable = inv.subtotalPaise - inv.discountPaise;
  const intra = inv.cgstPaise > 0 || inv.sgstPaise > 0;

  return (
    <>
      <div className="no-print card-row">
        <Link href="/payments" className="back">← Payments</Link>
        <div className="grow" />
        <PrintButton />
      </div>
      <div className="invoice">
        <div className="card-row" style={{ alignItems: "flex-start" }}>
          <div className="grow">
            <div className="page-title" style={{ fontSize: 22 }}>Tax invoice</div>
            <div className="cell-muted" style={{ marginTop: 4 }}>
              {inv.number} · issued {longDate(inv.issuedAt)} · {inv.status === "void" ? "VOID (refunded)" : inv.status === "paid" ? "paid" : "issued"}
            </div>
          </div>
          <div style={{ textAlign: "right", fontSize: 13 }}>
            <b>{seller.legalName}</b>
            <div>{seller.address}</div>
            <div>{seller.state}{seller.stateCode ? ` (${seller.stateCode})` : ""}</div>
            <div>GSTIN {seller.gstin ?? <span style={{ color: "var(--red)" }}>not set</span>}</div>
          </div>
        </div>

        <div style={{ margin: "22px 0", fontSize: 13 }}>
          <div className="label">Billed to</div>
          <b>{buyer.legalName}</b>
          {buyer.address && <div style={{ whiteSpace: "pre-line" }}>{buyer.address}</div>}
          <div>{buyer.state ?? "State not on file"}{buyer.stateCode ? ` (${buyer.stateCode})` : ""}</div>
          <div>GSTIN {buyer.gstin ?? "not provided"}</div>
          <div style={{ marginTop: 6 }}>Place of supply: {inv.placeOfSupply}</div>
        </div>

        <table>
          <thead>
            <tr><th>Description</th><th>SAC</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.description}</td><td>{l.hsnSac}</td><td className="num">{l.quantity}</td>
                <td className="num">{inrPaise(l.unitPaise)}</td><td className="num">{inrPaise(l.amountPaise)}</td>
              </tr>
            ))}
            {inv.discountPaise > 0 && (
              <tr><td colSpan={4}>Discount{inv.payment?.couponId ? " (coupon)" : ""}</td><td className="num">−{inrPaise(inv.discountPaise)}</td></tr>
            )}
            <tr><td colSpan={4}>Taxable value</td><td className="num">{inrPaise(taxable)}</td></tr>
            {intra ? (
              <>
                <tr><td colSpan={4}>CGST 9%</td><td className="num">{inrPaise(inv.cgstPaise)}</td></tr>
                <tr><td colSpan={4}>SGST 9%</td><td className="num">{inrPaise(inv.sgstPaise)}</td></tr>
              </>
            ) : (
              <tr><td colSpan={4}>IGST 18%</td><td className="num">{inrPaise(inv.igstPaise)}</td></tr>
            )}
            <tr className="total"><td colSpan={4}>Total</td><td className="num">{inrPaise(inv.totalPaise)}</td></tr>
          </tbody>
        </table>
        <div className="cell-muted" style={{ marginTop: 16 }}>
          {intra
            ? "Seller and buyer are in the same state, so GST is split into CGST and SGST."
            : "Seller and buyer are in different states (or the buyer's state is not on file), so IGST applies."}{" "}
          For {inv.subscription.tenant.name}.
        </div>
      </div>
    </>
  );
}
