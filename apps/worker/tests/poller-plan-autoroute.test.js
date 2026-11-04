import { describe, it, expect, beforeEach, vi } from 'vitest';

const tenantFind = vi.fn();
const jobFind = vi.fn();

vi.mock('@pratibha/prisma', () => ({
  prisma: {
    tenant: { findUnique: (...a) => tenantFind(...a) },
    job: { findMany: (...a) => jobFind(...a) },
    emailConnection: { findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock('../src/ingestion/imapClient.js', () => ({ fetchNewMessages: vi.fn(), watchMailbox: vi.fn() }));
vi.mock('../src/ingestion/createCandidate.js', () => ({ createCandidateFromEmail: vi.fn() }));

const { loadOpenJobs } = await import('../src/ingestion/poller.js');

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const connection = { id: 'c1', tenantId: 't1', autoRoute: true };
const jobs = [{ id: 'j1', title: 'Sales Executive', slug: 'sales-executive' }];

describe('auto-routing follows the plan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobFind.mockResolvedValue(jobs);
  });

  it('routes as before when the plan has nothing saved', async () => {
    tenantFind.mockResolvedValue({ plan: { key: 'starter', features: {} } });
    expect(await loadOpenJobs(connection, quiet)).toEqual(jobs);
  });

  it('files everything into the fallback job when the plan turns auto-routing off', async () => {
    tenantFind.mockResolvedValue({ plan: { key: 'starter', features: { auto_route_mailboxes: false } } });
    expect(await loadOpenJobs(connection, quiet)).toEqual([]);
    expect(jobFind).not.toHaveBeenCalled();
  });

  it('never looks at the plan for a one-job mailbox', async () => {
    expect(await loadOpenJobs({ ...connection, autoRoute: false }, quiet)).toEqual([]);
    expect(tenantFind).not.toHaveBeenCalled();
  });
});
