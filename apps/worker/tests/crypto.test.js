import { describe, it, expect } from 'vitest';
import { sealSecret, openSecret, isSealed, safeEqual } from '@pratibha/shared/crypto';

const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('sealSecret / openSecret', () => {
  it('round-trips a mailbox password, including non-ASCII', () => {
    const password = 'hunter2-àéî';
    expect(openSecret(sealSecret(password, KEY), KEY)).toBe(password);
  });

  it('produces different ciphertext each time, so equal passwords are not linkable', () => {
    expect(sealSecret('same', KEY)).not.toBe(sealSecret('same', KEY));
  });

  it('never leaves the plaintext visible in the stored value', () => {
    expect(sealSecret('SuperSecret123', KEY)).not.toContain('SuperSecret123');
  });

  it('refuses to open with the wrong key rather than returning garbage', () => {
    expect(() => openSecret(sealSecret('x', KEY), OTHER)).toThrow();
  });

  // The auth tag is the point of GCM: a row edited in the database must fail
  // loudly, not decrypt into something we then send to a mail server.
  it('rejects a tampered ciphertext', () => {
    const parts = sealSecret('correct horse', KEY).split('.');
    const bytes = Buffer.from(parts[3], 'base64');
    bytes[0] ^= 0xff;
    parts[3] = bytes.toString('base64');

    expect(() => openSecret(parts.join('.'), KEY)).toThrow();
  });

  it('rejects a malformed value', () => {
    expect(() => openSecret('not-sealed', KEY)).toThrow(/Malformed/);
  });

  it('accepts a passphrase that is not 32 raw bytes', () => {
    expect(openSecret(sealSecret('pw', 'short passphrase'), 'short passphrase')).toBe('pw');
  });

  it('recognises its own format without decrypting', () => {
    expect(isSealed(sealSecret('x', KEY))).toBe(true);
    expect(isSealed('plaintext')).toBe(false);
    expect(isSealed(null)).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal strings', () => {
    expect(safeEqual('token', 'token')).toBe(true);
    expect(safeEqual('token', 'toke')).toBe(false);
    expect(safeEqual('token', 'tokenn')).toBe(false);
  });
});
