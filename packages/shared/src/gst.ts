/**
 * Indian states and union territories, with their GST state codes.
 *
 * The code is the first two digits of a GSTIN, which is what makes this list
 * more than decoration: the customer's state decides whether an invoice splits
 * into CGST + SGST or charges IGST, and getting that wrong is the kind of error
 * a CA rejects the invoice for.
 */
export const GST_STATES = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' },
] as const;

export type GstStateName = (typeof GST_STATES)[number]['name'];

export function gstStateCode(name: string | null | undefined): string | null {
  if (!name) return null;
  return GST_STATES.find((s) => s.name.toLowerCase() === name.trim().toLowerCase())?.code ?? null;
}

/**
 * A GSTIN is 15 characters: two-digit state code, ten-character PAN, an entity
 * number, a fixed 'Z', and a checksum.
 *
 * Format only. A structurally valid GSTIN can still belong to nobody, and only
 * the GST portal can say otherwise — so this rejects typos, not fraud, and the
 * message it produces should not claim more than that.
 */
export function isValidGstin(value: string): boolean {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(value.trim().toUpperCase());
}

/** The state a GSTIN itself declares, which must match the address state. */
export function stateFromGstin(gstin: string): string | null {
  const code = gstin.trim().slice(0, 2);
  return GST_STATES.find((s) => s.code === code)?.name ?? null;
}
