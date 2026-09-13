import { describe, it, expect, beforeEach, vi } from 'vitest';

// The poller imports the Prisma client at module load, so it is stubbed before
// the module under test is pulled in.
const update = vi.fn().mockResolvedValue({});
const findMany = vi.fn();

vi.mock('@pratibha/prisma', () => ({
  prisma: {
    emailConnection: {
      findMany: (...args) => findMany(...args),
      update: (...args) => update(...args),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../src/ingestion/imapClient.js', () => ({
  fetchNewMessages: vi.fn(),
  watchMailbox: vi.fn(),
}));
vi.mock('../src/ingestion/createCandidate.js', () => ({ createCandidateFromEmail: vi.fn() }));
vi.mock('../src/ingestion/applicationFilter.js', () => ({ classifyMessage: vi.fn() }));
vi.mock('../src/ingestion/jobRouter.js', () => ({ matchJobFromMessage: vi.fn() }));

const { pollAllConnections, __resetBackoff } = await import('../src/ingestion/poller.js');
const imap = await import('../src/ingestion/imapClient.js');

const connection = {
  id: 'conn1',
  provider: 'imap',
  status: 'connected',
  address: 'hr@example.com',
  imapHost: 'mail.example.com',
  imapPort: 993,
  imapSecret: 'sealed',
  folder: 'INBOX',
  // Without a destination job the poller treats the mailbox as idle.
  defaultJobId: 'job1',
};

const quiet = { info: () => {}, error: () => {}, warn: () => {} };

describe('poller backoff', () => {
  beforeEach(() => {
    __resetBackoff();
    vi.clearAllMocks();
    findMany.mockResolvedValue([connection]);
    imap.fetchNewMessages.mockRejectedValue(new Error('Failed to establish connection in required time'));
  });

  // The bug this guards: a broken mailbox was retried on the fixed interval
  // forever. Three of those against one host got the production server's IP
  // firewalled by the mail provider.
  it('does not retry a failed mailbox on the very next tick', async () => {
    const first = await pollAllConnections(quiet);
    expect(first).toHaveLength(1);

    const second = await pollAllConnections(quiet);
    expect(second).toHaveLength(0);
    expect(imap.fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it('marks the connection as errored on failure', async () => {
    await pollAllConnections(quiet);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'conn1' },
      data: expect.objectContaining({ status: 'error' }),
    }));
  });

  it('stops attempting entirely once the mailbox has rolled off', async () => {
    // Far past any backoff window, so only the roll-off cap can hold it back.
    vi.spyOn(Date, 'now').mockReturnValue(0);
    for (let i = 0; i < 12; i++) {
      Date.now.mockReturnValue(i * 24 * 60 * 60 * 1000);
      await pollAllConnections(quiet);
    }
    const callsBefore = imap.fetchNewMessages.mock.calls.length;

    Date.now.mockReturnValue(365 * 24 * 60 * 60 * 1000);
    const attempted = await pollAllConnections(quiet);

    expect(attempted).toHaveLength(0);
    expect(imap.fetchNewMessages.mock.calls.length).toBe(callsBefore);
    Date.now.mockRestore();
  });

  it('clears the backoff once the mailbox answers again', async () => {
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow);

    await pollAllConnections(quiet);            // fails, opens a backoff window
    imap.fetchNewMessages.mockResolvedValue({ messages: [], uidValidity: 1n, lastSeenUid: 1n });

    Date.now.mockReturnValue(realNow + 60 * 60 * 1000);
    await pollAllConnections(quiet);            // window elapsed, and it answers

    // Immediately attempted again rather than sitting in a stale window.
    const after = await pollAllConnections(quiet);
    expect(after).toHaveLength(1);
    Date.now.mockRestore();
  });
});
