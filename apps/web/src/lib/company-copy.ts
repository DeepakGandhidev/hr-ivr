/**
 * Batch 8 copy strings, verbatim, punctuation included. Shared by the Company
 * profile page and its API so the warning reads the same in both places.
 */
export const COMPANY_COPY = {
  invoiceSubline: "Exactly as they should print on your GST invoices.",
  logoHelper: "PNG, JPG, SVG or WebP, up to 2 MB. Shown on your careers page and in candidate emails, on a white background.",
  descriptionHelper: "Shown on your hosted careers page, above the open roles. Two or three sentences work best.",
  gstinEmptyHelper: "15 characters. Leave blank if you are not registered.",
  stateHelper: "Decides whether invoices charge CGST + SGST or IGST.",
  footerBefore: "The billing email and payment method live in ",
} as const;

export function gstinValidLine(state: string, code: string) {
  return `Valid format · ${state} (${code}), matches your state`;
}

export function gstinMismatchWarning(code: string, gstinState: string, selectedState: string) {
  return `This GSTIN starts ${code}, which is ${gstinState}, but your state says ${selectedState}. One of the two is wrong, and invoices will charge the wrong tax until it is fixed.`;
}
