import { sealSecret, openSecret } from "@pratibha/shared/crypto";

/**
 * TOTP secrets at rest, sealed with AES-256-GCM under ADMIN_SECRET_KEY.
 *
 * Its own key, not the portal's EMAIL_SECRET_KEY: the portal never needs to
 * read these, so it is never given the means to.
 */
function key(): string {
  const k = process.env.ADMIN_SECRET_KEY;
  if (!k) throw new Error("ADMIN_SECRET_KEY is not set. Generate one with: openssl rand -hex 32");
  return k;
}

export const sealTotp = (secret: string) => sealSecret(secret, key());
export const openTotp = (sealed: string) => openSecret(sealed, key());
