/**
 * Feature flags read at build time.
 *
 * Two step verification (Batch 5, P04): the card stays out of the product,
 * with no mention of it anywhere, until the feature ships and this is set to
 * "on" in the portal's environment.
 */
export const TWO_FACTOR_ENABLED = process.env.NEXT_PUBLIC_FEATURE_TWO_FACTOR === "on";
