import { setting, settingSource } from "@pratibha/shared/settings-runtime";

/**
 * Feature flags.
 *
 * Two step verification (Batch 5, P04): the card stays out of the product,
 * with no mention of it anywhere, until the feature ships and this is set to
 * "on" in the portal's environment.
 *
 * Next inlines NEXT_PUBLIC_ variables at build time, so this constant is what
 * the build saw. Server only: pages read twoFactorEnabled() and pass the
 * answer down to their client components.
 */
export const TWO_FACTOR_ENABLED = process.env.NEXT_PUBLIC_FEATURE_TWO_FACTOR === "on";

/**
 * The admin panel's switch (Features, Portal) when one is saved, else the
 * build's flag. The build flag is checked here rather than through setting(),
 * because the environment spells it "on" and the registry's boolean reads
 * only "true".
 */
export function twoFactorEnabled(): boolean {
  if (settingSource("features.two_factor") === "panel") return setting<boolean>("features.two_factor");
  return TWO_FACTOR_ENABLED;
}
