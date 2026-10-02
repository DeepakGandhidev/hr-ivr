import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Two step codes: RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 second steps), the
 * scheme every authenticator app speaks. Written against node:crypto rather
 * than a library because it is forty lines and sits on the sign-in path, where
 * a dependency is one more thing to trust.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
/** One step either side, for a phone clock that has drifted a little. */
const WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new shared secret: 160 bits, the size RFC 4226 recommends. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3]) %
    10 ** DIGITS;
  return String(code).padStart(DIGITS, "0");
}

export function verifyTotp(secret: string, code: string, now: number = Date.now()): boolean {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;

  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  for (let drift = -WINDOW; drift <= WINDOW; drift++) {
    const expected = Buffer.from(totpAt(secret, counter + drift));
    if (timingSafeEqual(expected, Buffer.from(clean))) return true;
  }
  return false;
}

/** What an authenticator app scans or accepts by link. */
export function otpauthUri(secret: string, accountEmail: string): string {
  const label = encodeURIComponent(`Pratibha Admin:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("Pratibha Admin")}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** The secret in groups of four, for typing into an app by hand. */
export function groupedSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}
