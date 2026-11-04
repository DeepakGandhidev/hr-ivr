import { describe, it, expect, beforeEach, vi } from 'vitest';

const update = vi.fn().mockResolvedValue({});
const findMany = vi.fn();

vi.mock('@pratibha/prisma', () => ({
  prisma: {
    emailConnection: { findMany: (...a) => findMany(...a), update: (...a) => update(...a), findUnique: vi.fn() },
    job: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('../src/ingestion/imapClient.js', () => ({ fetchNewMessages: vi.fn(), watchMailbox: vi.fn() }));
vi.mock('../src/ingestion/createCandidate.js', () => ({ createCandidateFromEmail: vi.fn() }));
vi.mock('../src/ingestion/applicationFilter.js', () => ({ classifyMessage: vi.fn() }));
vi.mock('../src/ingestion/jobRouter.js', () => ({ matchJobFromMessage: vi.fn() }));

const { pollAllConnections, __resetBackoff } = await import('../src/ingestion/poller.js');
const imap = await import('../src/ingestion/imapClient.js');
const { OAuthRevokedError } = await import('@pratibha/shared/mail-oauth');

const quiet = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

const base = { status: 'connected', imapHost: 'imap.gmail.com', imapPort: 993, folder: 'INBOX', defaultJobId: 'job1' };

describe('poller with signed-in and forwarded mailboxes', () => {
  beforeEach(() => {
    __resetBackoff();
    vi.clearAllMocks();
    imap.fetchNewMessages.mockResolvedValue({ messages: [], uidValidity: null });
  });

  it('pulls Gmail and Outlook sign-ins, and leaves forwarding addresses to the receiver', async () => {
    findMany.mockResolvedValue([
      { ...base, id: 'g', provider: 'gmail', address: 'a@gmail.com', oauthRefreshSecret: 'sealed' },
      { ...base, id: 'o', provider: 'outlook', address: 'b@outlook.com', oauthRefreshSecret: 'sealed', imapHost: 'outlook.office365.com' },
      { ...base, id: 'f', provider: 'forward_alias', address: 'c@acme.com', imapHost: null, forwardToken: 'acme.k3x9q2m7wd' },
      // Signed in but no token stored: nothing to log in with.
      { ...base, id: 'x', provider: 'gmail', address: 'd@gmail.com', oauthRefreshSecret: null },
    ]);

    const attempted = await pollAllConnections(quiet);
    expect(attempted.map((c) => c.id)).toEqual(['g', 'o']);
  });

  it('does not turn a revoked sign-in back into a retried error', async () => {
    findMany.mockResolvedValue([{ ...base, id: 'g', provider: 'gmail', address: 'a@gmail.com', oauthRefreshSecret: 'sealed' }]);
    imap.fetchNewMessages.mockRejectedValue(new OAuthRevokedError('invalid_grant'));

    await pollAllConnections(quiet);
    expect(update).not.toHaveBeenCalled();
  });
});
