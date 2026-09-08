import crypto from 'crypto';

/**
 * Plivo webhook signature V3.
 *
 * The construction is fiddly and fails closed, so it is written here to match
 * Plivo's own validator (plivo-node `utils/v3Security.js`) exactly, including
 * two separators that are easy to miss and were previously absent:
 *
 *   POST:  <origin><path> "?" <sorted params> "." <nonce>
 *   GET:   <origin><path> "?" <sorted query>  "." <nonce>
 *
 *  - Params are sorted by key and concatenated as key+value with NO separator
 *    (query strings use key=value joined by "&").
 *  - A repeated key contributes each of its values, sorted.
 *  - The "?" is appended for a POST whenever there are post params, even when
 *    the URL itself carries no query string.
 *  - The nonce is appended after a literal ".".
 *
 * Getting this wrong rejects every real call with a 403 while looking healthy
 * from the outside, so `tests/plivo-signature.test.js` pins it against a
 * captured production webhook.
 */

function valuesOf(value) {
  return Array.isArray(value) ? [...value].map(String).sort() : [String(value)];
}

function sortedParamsString(params) {
  const out = [];
  for (const key of Object.keys(params).sort()) {
    for (const value of valuesOf(params[key])) out.push(`${key}${value}`);
  }
  return out.join('');
}

function sortedQueryString(params) {
  const out = [];
  for (const key of Object.keys(params).sort()) {
    for (const value of valuesOf(params[key])) out.push(`${key}=${value}`);
  }
  return out.join('&');
}

/**
 * `emptyPostParams` mirrors the SDK's third argument: it is true when the
 * request carries no POST body params, and it decides whether the "?" and the
 * trailing "." are appended.
 */
function constructGetUrl(uri, extraParams = {}, emptyPostParams = true) {
  const parsed = new URL(uri);

  const merged = {};
  for (const key of parsed.searchParams.keys()) {
    merged[key] = parsed.searchParams.getAll(key);
  }
  for (const [key, value] of Object.entries(extraParams)) {
    const incoming = valuesOf(value);
    merged[key] = merged[key] ? [...merged[key], ...incoming] : incoming;
  }

  let base = `${parsed.origin}${parsed.pathname}`;
  const query = sortedQueryString(merged);

  if (query.length > 0 || !emptyPostParams) base += `?${query}`;
  if (query.length > 0 && !emptyPostParams) base += '.';

  return base;
}

function constructPostUrl(uri, params) {
  const base = constructGetUrl(uri, {}, Object.keys(params).length === 0);
  return base + sortedParamsString(params);
}

export function computeV3Signature({ method, url, nonce, params = {}, authToken }) {
  const base = method === 'POST' ? constructPostUrl(url, params) : constructGetUrl(url, params);
  return crypto.createHmac('sha256', authToken).update(`${base}.${nonce}`).digest('base64');
}

export function verifyV3Signature({ method, url, nonce, params, authToken, header }) {
  if (!authToken || !nonce || !header) return false;

  const expected = computeV3Signature({ method, url, nonce, params, authToken });
  const want = Buffer.from(expected, 'utf8');

  // The header carries comma-separated signatures when an account has more than
  // one auth token; a match against any of them is a valid request.
  return String(header).split(',').some((candidate) => {
    const given = Buffer.from(candidate.trim(), 'utf8');
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  });
}

/**
 * Plivo signs the URL it was configured to call. Behind ngrok or nginx the
 * request arrives on http and an internal host, so the public URL has to be
 * rebuilt from the configured base or the forwarding headers, or every
 * signature fails.
 */
export function publicUrlOf(req, configuredBase) {
  if (configuredBase) return new URL(req.originalUrl, configuredBase).toString();
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}${req.originalUrl}`;
}
