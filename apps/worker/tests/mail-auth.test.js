import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.EMAIL_SECRET_KEY ??= 'a'.repeat(64);

const findUnique = vi.fn();
const update = vi.fn().mockResolvedValue({});
vi.mock('@pratibha/prisma', () => ({
  prisma: { emailConnection: { findUnique: (...a) => findUnique(...a), update: (...a) => update(...a) } },
}));

const refreshOAuthToken = vi.fn();
vi.mock('@pratibha/shared/mail-oauth', async (importOriginal) => ({
  ...(await importOriginal()),
  refreshOAuthToken: (...a) => refreshOAuthToken(...a),
}));

const { sealSecret, openSecret } = await import('@pratibha/shared/crypto');
const { OAuthRevokedError } = await import('@pratibha/shared/mail-oauth');
const { imapAuthFor } = await import('../src/ingestion/mailAuth.js');

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function gmailRow(overrides = {}) {
  return {
    id: 'g1',
    provider: 'gmail',
    address: 'hr@gmail.com',
    imapUsername: 'hr@gmail.com',
    oauthRefreshSecret: sealSecret('refresh-1'),
    oauthAccessSecret: sealSecret('access-old'),
    oauthExpiresAt: new Date(Date.now() - 1000),
    ...overrides,
  };
}

describe('imapAuthFor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the sealed password for a plain IMAP mailbox', async () => {
    const auth = await imapAuthFor({ id: 'i1', provider: 'imap', address: 'hr@acme.com', imapSecret: sealSecret('pw') }, quiet);
    expect(auth).toEqual({ user: 'hr@acme.com', pass: 'pw' });
  });

  it('reuses an access token that is still fresh', async () => {
    findUnique.mockResolvedValue(gmailRow({ oauthAccessSecret: sealSecret('access-live'), oauthExpiresAt: new Date(Date.now() + 30 * 60_000) }));
    expect(await imapAuthFor(gmailRow(), quiet)).toEqual({ user: 'hr@gmail.com', accessToken: 'access-live' });
    expect(refreshOAuthToken).not.toHaveBeenCalled();
  });

  it('refreshes an expired token once, even when asked twice at once, and stores the rotated refresh token', async () => {
    findUnique.mockResolvedValue(gmailRow());
    refreshOAuthToken.mockResolvedValue({ accessToken: 'access-new', refreshToken: 'refresh-2', expiresAt: new Date(Date.now() + 3600_000) });

    const [a, b] = await Promise.all([imapAuthFor(gmailRow(), quiet), imapAuthFor(gmailRow(), quiet)]);
    expect(a.accessToken).toBe('access-new');
    expect(b.accessToken).toBe('access-new');
    expect(refreshOAuthToken).toHaveBeenCalledTimes(1);
    expect(refreshOAuthToken).toHaveBeenCalledWith('gmail', 'refresh-1');

    const data = update.mock.calls[0][0].data;
    expect(openSecret(data.oauthAccessSecret)).toBe('access-new');
    expect(openSecret(data.oauthRefreshSecret)).toBe('refresh-2');
  });

  it('pauses the mailbox when the grant has been revoked', async () => {
    findUnique.mockResolvedValue(gmailRow());
    refreshOAuthToken.mockRejectedValue(new OAuthRevokedError('gmail token request failed: invalid_grant'));

    await expect(imapAuthFor(gmailRow(), quiet)).rejects.toBeInstanceOf(OAuthRevokedError);
    expect(update.mock.calls[0][0].data).toMatchObject({ status: 'revoked' });
    expect(update.mock.calls[0][0].data.errorDetail).toMatch(/Google access was withdrawn/);
  });
});
