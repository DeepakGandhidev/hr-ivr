import crypto from 'crypto';

export function createHMACSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

export function verifyHMACSignature(payload, signature, secret) {
  const expected = createHMACSignature(payload, secret);
  const given = Buffer.from(String(signature ?? ''), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, which on a signature check is
  // just a failed comparison.
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
