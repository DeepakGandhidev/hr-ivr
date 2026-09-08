import { describe, it, expect } from 'vitest';
import { computeV3Signature, verifyV3Signature, publicUrlOf } from '../src/utils/plivoSignature.js';

/**
 * Pinned against a real production webhook. The construction below was wrong in
 * two places — a missing "?" after the path and a missing "." before the nonce —
 * which rejected every genuine Plivo call with a 403 while the service looked
 * perfectly healthy. These fixtures use a synthetic auth token, but the string
 * construction is exactly what Plivo's own validator produces.
 *
 *   POST:  <origin><path> "?" <sorted key+value pairs> "." <nonce>
 */
const AUTH_TOKEN = 'test-auth-token';
const URL_ = 'https://example.ngrok-free.dev/pratibha/answer';
const NONCE = '50716346217456629210';

const PARAMS = {
  CallStatus: 'ringing',
  CallUUID: 'a5d8892b',
  From: '918076734039',
  To: '918031705255',
};

describe('Plivo V3 signature', () => {
  it('signs a POST as url + "?" + sorted params + "." + nonce', () => {
    expect(
      computeV3Signature({ method: 'POST', url: URL_, nonce: NONCE, params: PARAMS, authToken: AUTH_TOKEN })
    ).toBe('ExHPTf75eKjwF5lKnWxzRInDR9V5Z/ZhAbnCKhKZWns=');
  });

  it('omits the "?" when a POST carries no params', () => {
    expect(
      computeV3Signature({ method: 'POST', url: URL_, nonce: NONCE, params: {}, authToken: AUTH_TOKEN })
    ).toBe('ZP0kVcZvKZ9MJRwSFxwU1CAV2lDc+mISZEj1ndc4/vY=');
  });

  it('sorts query parameters for a GET', () => {
    expect(
      computeV3Signature({
        method: 'GET',
        url: 'https://example.ngrok-free.dev/pratibha/answer?b=2&a=1',
        nonce: NONCE,
        params: {},
        authToken: AUTH_TOKEN,
      })
    ).toBe('EVypE64i9E3wndQx7+GSRO8ZD2qFlvhZnZbhGbXQ4hI=');
  });

  it('is order independent — params are sorted by key, not by arrival', () => {
    const reordered = { To: PARAMS.To, From: PARAMS.From, CallUUID: PARAMS.CallUUID, CallStatus: PARAMS.CallStatus };
    expect(computeV3Signature({ method: 'POST', url: URL_, nonce: NONCE, params: reordered, authToken: AUTH_TOKEN }))
      .toBe(computeV3Signature({ method: 'POST', url: URL_, nonce: NONCE, params: PARAMS, authToken: AUTH_TOKEN }));
  });

  it('accepts a valid signature', () => {
    const sig = computeV3Signature({ method: 'POST', url: URL_, nonce: NONCE, params: PARAMS, authToken: AUTH_TOKEN });
    expect(verifyV3Signature({ method: 'POST', url: URL_, nonce: NONCE, params: PARAMS, authToken: AUTH_TOKEN, header: sig })).toBe(true);
  });

  it('accepts when the header carries several comma-separated signatures', () => {
    const sig = computeV3Signature({ method: 'POST', url: URL_, nonce: NONCE, params: PARAMS, authToken: AUTH_TOKEN });
    const header = `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=,${sig}`;
    expect(verifyV3Signature({ method: 'POST', url: URL_, nonce: NONCE, params: PARAMS, authToken: AUTH_TOKEN, header })).toBe(true);
  });

  it('rejects a tampered parameter', () => {
    const sig = computeV3Signature({ method: 'POST', url: URL_, nonce: NONCE, params: PARAMS, authToken: AUTH_TOKEN });
    const tampered = { ...PARAMS, From: '910000000000' };
    expect(verifyV3Signature({ method: 'POST', url: URL_, nonce: NONCE, params: tampered, authToken: AUTH_TOKEN, header: sig })).toBe(false);
  });

  it('fails closed with no header, nonce or token', () => {
    const base = { method: 'POST', url: URL_, nonce: NONCE, params: PARAMS, authToken: AUTH_TOKEN, header: 'x' };
    expect(verifyV3Signature({ ...base, header: undefined })).toBe(false);
    expect(verifyV3Signature({ ...base, nonce: undefined })).toBe(false);
    expect(verifyV3Signature({ ...base, authToken: undefined })).toBe(false);
  });
});

describe('publicUrlOf', () => {
  const req = (headers, originalUrl = '/pratibha/answer') => ({
    originalUrl,
    protocol: 'http',
    get: (h) => headers[h.toLowerCase()],
  });

  it('prefers the configured public base — behind a tunnel the host header is internal', () => {
    expect(publicUrlOf(req({ host: 'localhost:8091' }), 'https://example.ngrok-free.dev'))
      .toBe('https://example.ngrok-free.dev/pratibha/answer');
  });

  it('falls back to forwarding headers when no base is configured', () => {
    expect(publicUrlOf(req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.ngrok-free.dev', host: 'localhost:8091' })))
      .toBe('https://example.ngrok-free.dev/pratibha/answer');
  });
});
