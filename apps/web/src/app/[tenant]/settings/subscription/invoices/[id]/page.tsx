import { apiGet } from "@/lib/server-fetch";
import { formatInr } from "@pratibha/shared";
import InvoiceActions from "@/components/InvoiceActions";

interface Line {
  description: string;
  hsnSac: string;
  quantity: number;
  unitPaise: number;
  amountPaise: number;
}

interface Party {
  legalName: string | null;
  address: string | null;
  state: string | null;
  gstin: string | null;
}

interface Invoice {
  id: string;
  number: string;
  status: string;
  issuedAt: string;
  periodStart: string;
  periodEnd: string;
  lines: Line[];
  subtotalPaise: number;
  discountPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  placeOfSupply: string;
  seller: Party & { invoicePrefix?: string };
  buyer: Party;
}

/**
 * One invoice, as a document.
 *
 * Laid out to be printed: this is what a customer hands their CA, so it carries
 * every field a GST tax invoice is required to show — both GSTINs, the SAC code
 * per line, the place of supply, and the tax split under its correct heads.
 *
 * Rendered as a page rather than generated as a PDF because there is no PDF
 * library in this project, and adding one is a dependency decision rather than
 * a detail. The print stylesheet produces the same document through the
 * browser's own "Save as PDF"; the content is identical either way.
 */
export default async function InvoicePage({
  params,
}: {
  params: { tenant: string; id: string };
}) {
  const { tenant, id } = params;
  const data = await apiGet<{ invoice?: Invoice }>(
    `/api/${tenant}/subscription/invoices/${id}`,
    {}
  );
  const invoice = data.invoice;

  if (!invoice) {
    return (
      <div className="card empty">
        <p className="muted">That invoice could not be found.</p>
      </div>
    );
  }

  const intraState = invoice.cgstPaise > 0 || invoice.sgstPaise > 0;

  return (
    <div className="invoice-page">
      <InvoiceActions number={invoice.number} />

      <article className="invoice">
        <header className="invoice-head">
          <div>
            <h1>Tax Invoice</h1>
            <p className="invoice-number">{invoice.number}</p>
          </div>
          <div className="invoice-dates">
            <div><span>Invoice date</span> {new Date(invoice.issuedAt).toLocaleDateString("en-IN")}</div>
            <div>
              <span>Period</span>{" "}
              {new Date(invoice.periodStart).toLocaleDateString("en-IN")} –{" "}
              {new Date(invoice.periodEnd).toLocaleDateString("en-IN")}
            </div>
            <div><span>Status</span> {invoice.status}</div>
          </div>
        </header>

        <section className="invoice-parties">
          <div>
            <h2>From</h2>
            <p className="party-name">{invoice.seller.legalName}</p>
            {invoice.seller.address && <p className="party-line">{invoice.seller.address}</p>}
            <p className="party-line">State: {invoice.seller.state ?? "—"}</p>
            {/* Printed as missing rather than invented: a made-up GSTIN would
                make the invoice worse than an incomplete one. */}
            <p className="party-line">
              GSTIN: {invoice.seller.gstin ?? <em>not configured</em>}
            </p>
          </div>

          <div>
            <h2>To</h2>
            <p className="party-name">{invoice.buyer.legalName ?? "—"}</p>
            {invoice.buyer.address && <p className="party-line">{invoice.buyer.address}</p>}
            <p className="party-line">State: {invoice.buyer.state ?? "—"}</p>
            <p className="party-line">GSTIN: {invoice.buyer.gstin ?? <em>unregistered</em>}</p>
          </div>
        </section>

        <p className="invoice-pos">
          <strong>Place of supply:</strong> {invoice.placeOfSupply}
        </p>

        <table className="invoice-lines">
          <thead>
            <tr>
              <th>Description</th>
              <th>SAC</th>
              <th className="num">Qty</th>
              <th className="num">Rate</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line, i) => (
              <tr key={i}>
                <td>{line.description}</td>
                <td>{line.hsnSac}</td>
                <td className="num">{line.quantity}</td>
                <td className="num">{formatInr(line.unitPaise)}</td>
                <td className="num">{formatInr(line.amountPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <table className="invoice-totals">
          <tbody>
            <tr>
              <th>Subtotal</th>
              <td className="num">{formatInr(invoice.subtotalPaise)}</td>
            </tr>
            {invoice.discountPaise > 0 && (
              <tr>
                <th>Discount</th>
                <td className="num">− {formatInr(invoice.discountPaise)}</td>
              </tr>
            )}
            {/* One split or the other, never both: same state means CGST+SGST,
                different states mean IGST. */}
            {intraState ? (
              <>
                <tr>
                  <th>CGST @ 9%</th>
                  <td className="num">{formatInr(invoice.cgstPaise)}</td>
                </tr>
                <tr>
                  <th>SGST @ 9%</th>
                  <td className="num">{formatInr(invoice.sgstPaise)}</td>
                </tr>
              </>
            ) : (
              <tr>
                <th>IGST @ 18%</th>
                <td className="num">{formatInr(invoice.igstPaise)}</td>
              </tr>
            )}
            <tr className="grand">
              <th>Total</th>
              <td className="num">{formatInr(invoice.totalPaise)}</td>
            </tr>
          </tbody>
        </table>

        <footer className="invoice-foot">
          <p>
            This is a computer-generated invoice and does not require a
            signature.
          </p>
        </footer>
      </article>
    </div>
  );
}
