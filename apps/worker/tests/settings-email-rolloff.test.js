import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSettings, __resetSettingsRuntime } from '@pratibha/shared/settings-runtime';

// Same stubs as poller-backoff.test.js: the poller loads Prisma at import.
const findMany = vi.fn();
vi.mock('@pratibha/prisma', () => ({
  prisma: {
    emailConnection: { findMany: (...a) => findMany(...a), update: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
  },
}));
vi.mock('../src/ingestion/imapClient.js', () => ({ fetchNewMessages: vi.fn(), watchMailbox: vi.fn() }));
vi.mock('../src/ingestion/createCandidate.js', () => ({ createCandidateFromEmail: vi.fn() }));
vi.mock('../src/ingestion/applicationFilter.js', () => ({ classifyMessage: vi.fn() }));
vi.mock('../src/ingestion/jobRouter.js', () => ({ matchJobFromMessage: vi.fn() }));

const { pollAllConnections, __resetBackoff } = await import('../src/ingestion/poller.js');
const imap = await import('../src/ingestion/imapClient.js');

const quiet = { info: () => {}, error: () => {}, warn: () => {} };
const DAY = 24 * 60 * 60 * 1000;

/** Poll `n` times a day apart, far past any backoff window. */
async function failDaily(n) {
  for (let i = 0; i < n; i++) {
    Date.now.mockReturnValue(i * DAY);
    await pollAllConnections(quiet);
  }
  return imap.fetchNewMessages.mock.calls.length;
}

describe('mailbox roll-off count', () => {
  beforeEach(() => {
    __resetBackoff();
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(0);
    findMany.mockResolvedValue([{
      id: 'c1', provider: 'imap', status: 'connected', address: 'hr@example.com',
      imapHost: 'mail.example.com', imapPort: 993, imapSecret: 'sealed', folder: 'INBOX', defaultJobId: 'j1',
    }]);
    imap.fetchNewMessages.mockRejectedValue(new Error('Login failed'));
  });
  afterEach(() => {
    Date.now.mockRestore();
    __resetSettingsRuntime();
  });

  it('keeps retrying past 3 failures by default', async () => {
    expect(await failDaily(4)).toBe(4);
  });

  it('gives up after email.failure_rolloff failures', async () => {
    await startSettings({ app: 'worker', load: async () => [{ key: 'email.failure_rolloff', value: 3 }], logger: quiet, intervalMs: 1e9 });
    expect(await failDaily(6)).toBe(3);
  });
});
