import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettingsRuntime, startSettings } from '@pratibha/shared/settings-runtime';
import { teamRecipients } from '../src/notify/recipients.js';
import { notifyReportReady } from '../src/notify/reportReady.js';

const USERS = [
  { id: 'u-owner', tenantId: 't1', email: 'owner@acme.test', role: 'owner', removedAt: null, notificationPrefs: null },
  { id: 'u-admin', tenantId: 't1', email: 'admin@acme.test', role: 'admin', removedAt: null, notificationPrefs: { quota_warning: false } },
  { id: 'u-optout', tenantId: 't1', email: 'optout@acme.test', role: 'admin', removedAt: null, notificationPrefs: { report_ready: false } },
  { id: 'u-removed', tenantId: 't1', email: 'gone@acme.test', role: 'owner', removedAt: new Date('2026-09-01'), notificationPrefs: null },
  { id: 'u-viewer', tenantId: 't1', email: 'viewer@acme.test', role: 'viewer', removedAt: null, notificationPrefs: null },
  { id: 'u-reviewer', tenantId: 't1', email: 'reviewer@acme.test', role: 'reviewer', removedAt: null, notificationPrefs: null },
  { id: 'u-other', tenantId: 't2', email: 'owner@other.test', role: 'owner', removedAt: null, notificationPrefs: null },
];

/** Applies the where clause the way Postgres would, so the query itself is tested. */
function fakeUsers(users = USERS) {
  return {
    findMany: vi.fn(async ({ where }) =>
      users.filter(
        (u) =>
          u.tenantId === where.tenantId &&
          where.role.in.includes(u.role) &&
          (where.removedAt === null ? u.removedAt === null : true)
      )
    ),
  };
}

function fakeDb({ report = { recommendation: 'yes', recommendationScore: 7.84 } } = {}) {
  return {
    user: fakeUsers(),
    interviewCall: {
      findUnique: vi.fn(async ({ where }) => ({
        id: where.id,
        assessmentReport: report,
        candidate: {
          id: 'cand-9',
          name: 'Ananya Rao',
          job: { title: 'Backend Engineer' },
          tenant: { id: 't1', name: 'Acme', slug: 'acme' },
        },
      })),
    },
  };
}

const sent = () => vi.fn(async () => ({ ok: true, status: 'sent' }));

beforeEach(() =>
  startSettings({
    app: 'worker',
    load: async () => [{ key: 'brand.app_url', value: 'https://app.pratibha.test/' }],
    intervalMs: 3_600_000,
  })
);
afterEach(() => __resetSettingsRuntime());

describe('teamRecipients', () => {
  it('asks only for live owners and admins of the workspace', async () => {
    const db = { user: fakeUsers() };
    await teamRecipients(db, 't1', 'report_ready');
    expect(db.user.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 't1',
      role: { in: ['owner', 'admin'] },
      removedAt: null,
    });
  });

  it('leaves out viewers, reviewers, removed members, other workspaces and anyone who switched it off', async () => {
    const report = await teamRecipients({ user: fakeUsers() }, 't1', 'report_ready');
    expect(report.map((u) => u.id)).toEqual(['u-owner', 'u-admin']);

    const quota = await teamRecipients({ user: fakeUsers() }, 't1', 'quota_warning');
    expect(quota.map((u) => u.id)).toEqual(['u-owner', 'u-optout']);
  });
});

describe('notifyReportReady', () => {
  it('emails each eligible recipient a link to the candidate, keyed per call and person', async () => {
    const send = sent();
    const db = fakeDb();
    const result = await notifyReportReady('call-1', { db, send });

    expect(result).toEqual({ notified: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([, mail]) => [mail.to, mail.dedupeKey])).toEqual([
      ['owner@acme.test', 'report_ready:call-1:u-owner'],
      ['admin@acme.test', 'report_ready:call-1:u-admin'],
    ]);

    const [passedDb, mail] = send.mock.calls[0];
    expect(passedDb).toBe(db);
    expect(mail.kind).toBe('report_ready');
    expect(mail.tenantId).toBe('t1');
    expect(mail.subject).toBe('Interview report ready: Ananya Rao for Backend Engineer');
    expect(mail.text).toContain('https://app.pratibha.test/acme/candidates/cand-9');
    expect(mail.text).toContain('Overall: 7.8 out of 10. Recommendation: Advance.');
    expect(mail.text).toContain('— Pratibha, for Acme');
  });

  it('leaves the score line out when the report has no overall score', async () => {
    const send = sent();
    await notifyReportReady('call-1', { db: fakeDb({ report: { recommendation: 'maybe', recommendationScore: null } }), send });
    expect(send.mock.calls[0][1].text).not.toContain('out of 10');
  });

  it('sends nothing when the call has no report', async () => {
    const send = sent();
    expect(await notifyReportReady('call-1', { db: fakeDb({ report: null }), send })).toEqual({ notified: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not count a duplicate as sent', async () => {
    const send = vi.fn(async () => ({ ok: true, status: 'duplicate' }));
    expect(await notifyReportReady('call-1', { db: fakeDb(), send })).toEqual({ notified: 0 });
  });

  it('never throws: a database or mail fault is logged and swallowed', async () => {
    const logger = { error: vi.fn() };
    const db = fakeDb();
    db.interviewCall.findUnique = vi.fn(async () => {
      throw new Error('connection reset');
    });
    await expect(notifyReportReady('call-1', { db, send: sent(), logger })).resolves.toMatchObject({ notified: 0, error: 'connection reset' });

    const send = vi.fn(async () => {
      throw new Error('smtp down');
    });
    await expect(notifyReportReady('call-1', { db: fakeDb(), send, logger })).resolves.toMatchObject({ error: 'smtp down' });
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
