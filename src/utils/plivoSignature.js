import crypto from 'crypto';

/**
 * Plivo webhook signature V3.
 *
 * The signed string is the request URL stripped of its query, followed by every
 * POST parameter as name+value in case-sensitive name order with no separators,
 * followed by the nonce. HMAC-SHA256 under the auth token, base64.
 *
 * The header may carry several comma-separated signatures when an account has
 * more than one auth token, and a match against any of them is a valid request.
 *
 * Confirm this against the first real webhook before go-live: a wrong
 * reconstruction fails closed, which means every candidate call is refused.
 * `npm run check:signature` replays a captured request through it.
 */
export function computeV3Signature({ method, url, nonce, params = {}, authToken }) {
  const parsed = new URL(url);
  let signed = method === 'POST' ? `${parsed.origin}${parsed.pathname}` : parsed.toString();

  if (method === 'POST') {
    for (const key of Object.keys(params).sort()) signed += `${key}${params[key]}`;
  }

  return crypto.createHmac('sha256', authToken).update(`${signed}${nonce}`).digest('base64');
}

export function verifyV3Signature({ method, url, nonce, params, authToken, header }) {
  if (!authToken || !nonce || !header) return false;

  const expected = computeV3Signature({ method, url, nonce, params, authToken });
  const want = Buffer.from(expected, 'utf8');

  return String(header).split(',').some((candidate) => {
    const given = Buffer.from(candidate.trim(), 'utf8');
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  });
}

/**
 * Plivo signs the URL it was configured to call. Behind nginx the request
 * arrives on http and an internal host, so the public URL has to be rebuilt
 * from the forwarding headers or every signature fails.
 */
export function publicUrlOf(req, configuredBase) {
  if (configuredBase) return new URL(req.originalUrl, configuredBase).toString();
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}${req.originalUrl}`;
}
