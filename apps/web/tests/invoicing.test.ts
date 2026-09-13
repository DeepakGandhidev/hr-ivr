import { describe, it, expect } from "vitest";
import {
  calculateInvoice,
  taxSplitFor,
  financialYear,
  nextInvoiceNumber,
  formatInr,
  GST_RATE_PERCENT,
} from "@pratibha/shared";

describe("GST split", () => {
  /**
   * Same state: 18% becomes CGST 9 + SGST 9. Different states: IGST 18. This is
   * the most common reason an Indian invoice is rejected.
   */
  it("splits into CGST and SGST within one state", () => {
    const tax = taxSplitFor(100_000, "Maharashtra", "Maharashtra");
    expect(tax.intraState).toBe(true);
    expect(tax.cgstPaise).toBe(9_000);
    expect(tax.sgstPaise).toBe(9_000);
    expect(tax.igstPaise).toBe(0);
  });

  it("charges IGST across states", () => {
    const tax = taxSplitFor(100_000, "Maharashtra", "Karnataka");
    expect(tax.intraState).toBe(false);
    expect(tax.igstPaise).toBe(18_000);
    expect(tax.cgstPaise).toBe(0);
    expect(tax.sgstPaise).toBe(0);
  });

  // Over-collecting under the wrong heads is correctable; splitting a genuinely
  // inter-state supply understates IGST.
  it("falls back to IGST when the buyer's state is unknown", () => {
    expect(taxSplitFor(100_000, "Maharashtra", null).igstPaise).toBe(18_000);
    expect(taxSplitFor(100_000, "Maharashtra", "Nowhere").igstPaise).toBe(18_000);
  });

  // An odd paise must not vanish between the two halves.
  it("keeps CGST + SGST equal to what IGST would have been", () => {
    for (const amount of [1, 7, 333, 99_999, 123_457]) {
      const intra = taxSplitFor(amount, "Delhi", "Delhi");
      const inter = taxSplitFor(amount, "Delhi", "Haryana");
      expect(intra.cgstPaise + intra.sgstPaise).toBe(inter.igstPaise);
    }
  });
});

describe("invoice totals", () => {
  const lines = [{ description: "Growth plan", quantity: 1, unitPaise: 1_299_900 }];

  it("adds tax to the subtotal", () => {
    const inv = calculateInvoice({ lines, sellerState: "Karnataka", buyerState: "Karnataka" });
    expect(inv.subtotalPaise).toBe(1_299_900);
    expect(inv.totalPaise).toBe(1_299_900 + Math.round((1_299_900 * GST_RATE_PERCENT) / 100));
  });

  // Tax is owed on what was actually charged. Taxing the pre-discount amount
  // overcharges the customer and overstates our liability.
  it("discounts before tax, not after", () => {
    const inv = calculateInvoice({
      lines,
      discountPaise: 299_900,
      sellerState: "Karnataka",
      buyerState: "Karnataka",
    });
    expect(inv.taxablePaise).toBe(1_000_000);
    expect(inv.tax.cgstPaise + inv.tax.sgstPaise).toBe(180_000);
    expect(inv.totalPaise).toBe(1_180_000);
  });

  // Negative tax is not a refund, it is a broken invoice.
  it("never lets a discount exceed the bill", () => {
    const inv = calculateInvoice({
      lines,
      discountPaise: 99_999_999,
      sellerState: "Karnataka",
      buyerState: "Karnataka",
    });
    expect(inv.taxablePaise).toBe(0);
    expect(inv.totalPaise).toBe(0);
    expect(inv.discountPaise).toBe(1_299_900);
  });

  it("defaults every line to a SAC code", () => {
    const inv = calculateInvoice({ lines, sellerState: "Delhi", buyerState: "Delhi" });
    expect(inv.lines[0].hsnSac).toBe("998319");
  });

  it("prices quantities, for minute top-ups", () => {
    const inv = calculateInvoice({
      lines: [{ description: "100 interview minutes", quantity: 100, unitPaise: 1_500 }],
      sellerState: "Delhi",
      buyerState: "Delhi",
    });
    expect(inv.subtotalPaise).toBe(150_000);
  });
});

describe("invoice numbering", () => {
  // The Indian financial year runs April to March, and invoice series restart
  // with it.
  it("puts April into the new financial year and March into the old one", () => {
    expect(financialYear(new Date("2026-04-01T00:00:00Z"))).toBe("2026-27");
    expect(financialYear(new Date("2026-03-31T00:00:00Z"))).toBe("2025-26");
    expect(financialYear(new Date("2026-12-31T00:00:00Z"))).toBe("2026-27");
  });

  it("numbers sequentially within the year", () => {
    const date = new Date("2026-09-14T00:00:00Z");
    expect(nextInvoiceNumber("PMT", date, 0)).toBe("PMT/2026-27/0001");
    expect(nextInvoiceNumber("PMT", date, 6)).toBe("PMT/2026-27/0007");
  });
});

describe("formatting", () => {
  it("renders paise as rupees", () => {
    expect(formatInr(1_299_900)).toContain("12,999.00");
    expect(formatInr(0)).toContain("0.00");
  });
});
