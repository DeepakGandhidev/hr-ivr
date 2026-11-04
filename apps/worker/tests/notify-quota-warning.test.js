import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetSettingsRuntime, startSettings } from '@pratibha/shared/settings-runtime';
import { PLANS, TRIAL_LIMITS } from '@pratibha/shared';
import { minuteAllowance, notifyQuotaIfLow } from '../src/notify/quotaWarning.js';

const USERS = [
  { id: 'u-owner', tenantId: 't1', email: 'owner@acme.test', role: 'owner', removedAt: null, notificationPrefs: {} },
  { id: 'u-admin', tenantId: 't1', email: 'admin@acme.test', role: 'admin', removedAt: null, notificationPrefs: { quota_warning: false } },
];

function fakeDb({ tenant = {}, trial = null } = {}) {
  return {
    user: {
      findMany: vi.fn(async ({ where }) => USERS.filter((u) => u.tenantId === where.tenantId && where.role.in.includes(u.role))),
    },
    tenant: {
      findUnique: vi.fn(async () => ({
        id: 't1',
        name: 'Acme',
        slug: 'acme',
        status: 'active',
        planId: 'plan-row-1',
        plan: { key: 'starter', minutes: 100 },
        subscription: { topUpMinutes: 0 },
        ...tenant,
      })),
    },
    trialConfig: { findFirst: vi.fn(async () => trial) },
  };
}

const meter = (used) => ({ tenantId: 't1', period: '2026-10', interviewMinutesUsed: used });
const sent = () => vi.fn(async () => ({ ok: true, status: 'sent' }));

function panel(rows = {}) {
  return startSettings({
    app: 'worker',
    load: async () => Object.entries({ 'brand.app_url': 'https://app.pratibha.test', ...rows }).map(([key, value]) => ({ key, value })),
    intervalMs: 3_600_000,
  });
}

afterEach(() => __resetSettingsRuntime());

describe('notifyQuotaIfLow', () => {
  it('sends nothing below the warning level', async () => {
    await panel();
    const send = sent();
    expect(await notifyQuotaIfLow(meter(79), { db: fakeDb(), send })).toEqual({ notified: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('warns at the threshold, once per month per person, with the usage and a link to Subscription', async () => {
    await panel();
    const send = sent();
    const result = await notifyQuotaIfLow(meter(80), { db: fakeDb(), send });

    expect(result).toEqual({ notified: 1, level: 'warning' });
    // The admin switched quota warnings off.
    expect(send).toHaveBeenCalledTimes(1);
    const [, mail] = send.mock.calls[0];
    expect(mail).toMatchObject({
      kind: 'quota_warning',
      tenantId: 't1',
      to: 'owner@acme.test',
      dedupeKey: 'quota_warning:t1:2026-10-01:80:u-owner',
      subject: 'Acme has used 80% of its interview minutes',
    });
    expect(mail.text).toContain('Acme has used 80 of its 100 interview minutes this month. 20 are left.');
    expect(mail.text).toContain('https://app.pratibha.test/acme/settings/subscription');
  });

  it('follows the warning level set in the admin panel', async () => {
    await panel({ 'billing.quota_warning_percent': 90 });
    const send = sent();
    expect(await notifyQuotaIfLow(meter(85), { db: fakeDb(), send })).toEqual({ notified: 0 });
    await notifyQuotaIfLow(meter(90), { db: fakeDb(), send });
    expect(send.mock.calls[0][1].dedupeKey).toBe('quota_warning:t1:2026-10-01:90:u-owner');
  });

  it('sends the run-out email at 100%, under its own key', async () => {
    await panel();
    const send = sent();
    const result = await notifyQuotaIfLow(meter(104), { db: fakeDb(), send });

    expect(result.level).toBe('exhausted');
    const [, mail] = send.mock.calls[0];
    expect(mail.dedupeKey).toBe('quota_warning:t1:2026-10-01:100:u-owner');
    expect(mail.subject).toBe('Acme has used all its interview minutes');
    expect(mail.text).toContain('Acme has used 104 interview minutes this month, its full allowance of 100.');
  });

  it('counts minutes bought or granted on top of the plan', async () => {
    await panel();
    const send = sent();
    const db = fakeDb({ tenant: { subscription: { topUpMinutes: 100 } } });
    expect(await notifyQuotaIfLow(meter(150), { db, send })).toEqual({ notified: 0 });
    await notifyQuotaIfLow(meter(160), { db, send });
    expect(send.mock.calls[0][1].text).toContain('160 of its 200');
  });

  it('never warns an unmetered plan, and ignores a meter it cannot place', async () => {
    await panel();
    const send = sent();
    const db = fakeDb({ tenant: { plan: { key: 'custom', minutes: null }, planId: 'custom' } });
    expect(await notifyQuotaIfLow(meter(10_000), { db, send })).toEqual({ notified: 0 });
    expect(await notifyQuotaIfLow({}, { db, send })).toEqual({ notified: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    await panel();
    const logger = { error: vi.fn() };
    const db = fakeDb();
    db.tenant.findUnique = vi.fn(async () => {
      throw new Error('connection reset');
    });
    await expect(notifyQuotaIfLow(meter(100), { db, send: sent(), logger })).resolves.toMatchObject({ error: 'connection reset' });
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe('minuteAllowance', () => {
  it("uses the workspace's plan row, else the shared plan of the same key", async () => {
    const db = fakeDb();
    expect(await minuteAllowance(db, { status: 'active', plan: { key: 'starter', minutes: 120 } })).toBe(120);
    expect(await minuteAllowance(db, { status: 'active', planId: 'growth', plan: null })).toBe(PLANS.growth.limits.interviewMinutes);
  });

  it('uses the newest published trial on trial, with the shipped figure behind it', async () => {
    const withTrial = fakeDb({ trial: { minutes: 30 } });
    expect(await minuteAllowance(withTrial, { status: 'trial', subscription: { topUpMinutes: 5 } })).toBe(35);
    expect(withTrial.trialConfig.findFirst.mock.calls[0][0]).toMatchObject({ where: { status: 'published' }, orderBy: { publishedAt: 'desc' } });
    expect(await minuteAllowance(fakeDb(), { status: 'trial' })).toBe(TRIAL_LIMITS.interviewMinutes);
  });
});
