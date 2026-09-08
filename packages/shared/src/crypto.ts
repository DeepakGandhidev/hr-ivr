import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * IMAP is password auth, not OAuth: connecting a cPanel/webmail mailbox means
 * we hold a credential that opens the tenant's real inbox. It must never sit in
 * the database in plaintext, and it must be readable again later (unlike a
 * login password, which would be hashed), because the poller has to replay it
 * to the IMAP server on every connect.
 *
 * So: authenticated symmetric encryption. AES-256-GCM gives confidentiality and
 * tamper detection, and the auth tag means a row edited in the database fails
 * to open rather than silently decrypting to garbage we would then send to a
 * mail server as a login attempt.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const VERSION = 'v1';

/** Fixed salt: the key is already high-entropy config, not a user password. */
const KEY_SALT = 'pratibha-email-credential-v1';

function resolveKey(secret?: string): Buffer {
  const raw = secret ?? process.env.EMAIL_SECRET_KEY;
  if (!raw) {
    throw new Error(
      'EMAIL_SECRET_KEY is not set. Generate one with: openssl rand -hex 32'
    );
  }
  // A 64-char hex string is used as the key directly; anything else is
  // stretched, so a short passphrase in .env still yields a 32-byte key.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return scryptSync(raw, KEY_SALT, 32);
}

/** Encrypt a mailbox password for storage. Returns `v1.<iv>.<tag>.<ciphertext>`. */
export function sealSecret(plaintext: string, secret?: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('sealSecret requires a non-empty string');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, resolveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/** Reverse of {@link sealSecret}. Throws if the row was tampered with. */
export function openSecret(sealed: string, secret?: string): string {
  const parts = String(sealed ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed sealed secret');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, resolveKey(secret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** True when a value looks like our sealed format, without trying to decrypt. */
export function isSealed(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}.`) && value.split('.').length === 4;
}

/**
 * Constant-time compare for inbound webhook tokens, so a caller cannot learn a
 * shared secret one byte at a time from response timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
