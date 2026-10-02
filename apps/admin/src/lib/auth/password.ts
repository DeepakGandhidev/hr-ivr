import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

/**
 * Admin passwords, hashed with scrypt from node:crypto.
 *
 * Stored as `scrypt$N$r$p$salt$hash` so the cost can be raised later without
 * invalidating existing hashes: verification reads the parameters back out of
 * the stored string rather than assuming today's.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

export const MIN_PASSWORD_LENGTH = 12;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64url");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64url"), Number(n), Number(r), Number(p));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Why a new password is refused, or null when it is acceptable.
 *
 * Length over composition rules: a long passphrase beats a short password with
 * a symbol in it, and composition rules mostly teach people to write the
 * password down.
 */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (email && password.toLowerCase().includes(email.split("@")[0].toLowerCase())) {
    return "The password must not contain your email name.";
  }
  return null;
}
