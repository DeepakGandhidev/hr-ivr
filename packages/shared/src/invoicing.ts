import { gstStateCode } from './gst.js';

/**
 * Money is in paise, as integers, everywhere in this module.
 *
 * Floating point on money produces invoices that are off by a rupee, and a CA
 * who finds one stops trusting all of them. Rupees exist only for display, at
 * the very edge.
 */
export const GST_RATE_PERCENT = 18;

/** SAC for "Other information technology services". */
export const DEFAULT_SAC_CODE = '998319';

export interface InvoiceLineInput {
  description: string;
  /** HSN for goods, SAC for services. We sell services. */
  hsnSac?: string;
  quantity: number;
  unitPaise: number;
}

export interface InvoiceLine extends InvoiceLineInput {
  hsnSac: string;
  amountPaise: number;
}

export interface TaxSplit {
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  /** True when seller and buyer are in the same state. */
  intraState: boolean;
}

export interface InvoiceTotals {
  lines: InvoiceLine[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  tax: TaxSplit;
  totalPaise: number;
}

/**
 * Which tax applies.
 *
 * Same state: the 18% splits into CGST 9% + SGST 9%. Different states, or a
 * customer whose state we do not know: IGST 18%. Getting this wrong is the
 * single most common reason an Indian invoice is rejected, and it is decided
 * by state, not by address text - which is why billingState is its own field.
 *
 * An unknown buyer state falls back to IGST rather than guessing intra-state:
 * over-collecting the same total under the wrong heads is correctable, whereas
 * splitting a genuinely inter-state supply understates IGST.
 */
export function taxSplitFor(
  taxablePaise: number,
  sellerState: string | null | undefined,
  buyerState: string | null | undefined,
  ratePercent: number = GST_RATE_PERCENT
): TaxSplit {
  const total = Math.round((taxablePaise * ratePercent) / 100);

  const sellerCode = gstStateCode(sellerState);
  const buyerCode = gstStateCode(buyerState);
  const intraState = Boolean(sellerCode && buyerCode && sellerCode === buyerCode);

  if (!intraState) {
    return { cgstPaise: 0, sgstPaise: 0, igstPaise: total, intraState: false };
  }

  // Halved so the two halves always re-add to the total: an odd number of paise
  // must not vanish, and CGST + SGST has to equal what IGST would have been.
  const half = Math.floor(total / 2);
  return {
    cgstPaise: half,
    sgstPaise: total - half,
    igstPaise: 0,
    intraState: true,
  };
}

/**
 * Build one invoice's figures.
 *
 * The discount is applied BEFORE tax, because tax is owed on what was actually
 * charged. Taxing the pre-discount amount overcharges the customer and
 * overstates our liability.
 */
export function calculateInvoice({
  lines,
  discountPaise = 0,
  sellerState,
  buyerState,
  ratePercent = GST_RATE_PERCENT,
}: {
  lines: InvoiceLineInput[];
  discountPaise?: number;
  sellerState: string | null | undefined;
  buyerState: string | null | undefined;
  ratePercent?: number;
}): InvoiceTotals {
  const priced: InvoiceLine[] = lines.map((line) => ({
    ...line,
    hsnSac: line.hsnSac ?? DEFAULT_SAC_CODE,
    amountPaise: Math.round(line.quantity * line.unitPaise),
  }));

  const subtotalPaise = priced.reduce((sum, l) => sum + l.amountPaise, 0);

  // A discount can never exceed the bill: a negative taxable value would
  // produce negative tax, which is not a refund, it is a broken invoice.
  const discount = Math.max(0, Math.min(discountPaise, subtotalPaise));
  const taxablePaise = subtotalPaise - discount;

  const tax = taxSplitFor(taxablePaise, sellerState, buyerState, ratePercent);
  const totalPaise = taxablePaise + tax.cgstPaise + tax.sgstPaise + tax.igstPaise;

  return { lines: priced, subtotalPaise, discountPaise: discount, taxablePaise, tax, totalPaise };
}

/** Paise to a rupee string, for display and for the invoice itself. */
export function formatInr(paise: number): string {
  const rupees = paise / 100;
  return rupees.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * The Indian financial year a date falls in: April to March.
 *
 * Invoice numbers restart each financial year, so this is what decides which
 * series a new invoice joins.
 */
export function financialYear(date: Date): string {
  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Next invoice number in a financial year's series.
 *
 * Sequential and gapless within the year, which GST expects: a missing number
 * is a question an auditor will ask. `lastSequence` must come from a counted
 * query inside the same transaction that inserts the invoice, or two
 * simultaneous issues take the same number.
 */
export function nextInvoiceNumber(prefix: string, date: Date, lastSequence: number): string {
  return `${prefix}/${financialYear(date)}/${String(lastSequence + 1).padStart(4, '0')}`;
}
