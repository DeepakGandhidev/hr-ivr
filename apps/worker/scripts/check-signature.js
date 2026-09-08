/**
 * Replays a captured Plivo webhook through the signature validator.
 *
 * Worth running before go-live. Signature validation fails closed, so if the
 * signed-string reconstruction is wrong every candidate call is rejected with a
 * 403 and the line appears dead - a failure that looks like a telephony problem
 * and is not one.
 *
 * Capture a real request first: set PLIVO_VERIFY_SIGNATURE=false, take one live
 * call, and copy the headers and form body out of the logs.
 *
 *   node scripts/check-signature.js captured.json
 *
 * captured.json:
 *   {
 *     "method": "POST",
 *     "url": "https://hiring.promonkey.tech/pratibha/answer",
 *     "nonce": "<X-Plivo-Signature-V3-Nonce>",
 *     "signature": "<X-Plivo-Signature-V3>",
 *     "params": { "CallUUID": "...", "From": "...", "To": "..." }
 *   }
 */
import 'dotenv/config';
import fs from 'fs';
import { computeV3Signature, verifyV3Signature } from '../src/utils/plivoSignature.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-signature.js <captured.json>');
  process.exit(1);
}

const captured = JSON.parse(fs.readFileSync(file, 'utf8'));
const authToken = process.env.PLIVO_AUTH_TOKEN;

if (!authToken) {
  console.error('PLIVO_AUTH_TOKEN is not set');
  process.exit(1);
}

const { method = 'POST', url, nonce, signature, params = {} } = captured;
const computed = computeV3Signature({ method, url, nonce, params, authToken });
const ok = verifyV3Signature({ method, url, nonce, params, authToken, header: signature });

console.log(`\n  method     ${method}`);
console.log(`  url        ${url}`);
console.log(`  nonce      ${nonce}`);
console.log(`  params     ${Object.keys(params).sort().join(', ') || '(none)'}`);
console.log(`\n  received   ${signature}`);
console.log(`  computed   ${computed}`);
console.log(`\n  ${ok ? 'MATCH - validation is correct' : 'MISMATCH - do not enable verification yet'}\n`);

if (!ok) {
  console.log('  Things that make this mismatch, in order of likelihood:');
  console.log('   - url is not byte-identical to what Plivo was configured to call');
  console.log('     (http vs https, a trailing slash, or the internal host behind nginx)');
  console.log('   - params omits a field Plivo sent, or includes one it did not');
  console.log('   - the auth token belongs to a different Plivo account\n');
  process.exit(2);
}
