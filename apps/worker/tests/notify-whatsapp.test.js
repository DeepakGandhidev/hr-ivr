import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettingsRuntime, startSettings } from '@pratibha/shared/settings-runtime';
import { whatsappRecipients } from '../src/notify/recipients.js';
import { notifyReportReady } from '../src/notify/reportReady.js';
import { notifyQuotaIfLow } from '../src/notify/quotaWarning.js';

// Never the real Meta: a WhatsApp send that slipped past the fakes fails here.
vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error('no network in tests');
}));

const USERS = [
  { id: 'u-owner', tenantId: 't1', email: 'owner@acme.test', role: 'owner', removedAt: null, notificationPrefs: null, phoneE164: '+919800000001', whatsappOptIn: true },
  { id: 'u-admin', tenantId: 't1', email: 'admin@acme.test', role: 'admin', removedAt: null, notificationPrefs: null, phoneE164: '+919800000002', whatsappOptIn: false },
  { id: 'u-nophone', tenantId: 't1', email: 'np@acme.test', role: 'admin', removedAt: null, notificationPrefs: null, phoneE164: null, whatsappOptIn: true },
  { id: 'u-off', tenantId: 't1', email: 'off@acme.test', role: 'admin', removedAt: null, notificationPrefs: { report_ready: false, quota_warning: false }, phoneE164: '+919800000004', whatsappOptIn: true },
  { id: 'u-removed', tenantId: 't1', email: 'gone@acme.test', role: 'owner', removedAt: new Date('2026-09-01'), notificationPrefs: null, phoneE164: '+919800000005', whatsappOptIn: true },
];

function fakeDb() {
  return {
    user: {
      findMany: vi.fn(async ({ where }) =>
        USERS.filter((u) => u.tenantId === where.tenantId && where.role.in.includes(u.role) && (where.removedAt === null ? u.removedAt === null : true))
      ),
    },
    interviewCall: {
      findUnique: vi.fn(async ({ where }) => ({
        id: where.id,
        assessmentReport: { recommendation: 'yes', recommendationScore: 7.84 },
        candidate: { id: 'cand-9', name: 'Ananya Rao', job: { title: 'Backend Engineer' }, tenant: { id: 't1', name: 'Acme', slug: 'acme' } },
      })),
    },
    tenant: {
      findUnique: vi.fn(async () => ({
        id: 't1',
        name: 'Acme',
        slug: 'acme',
        status: 'active',
        planId: 'p1',
        plan: { key: 'starter', minutes: 100 },
        subscription: { topUpMinutes: 0 },
      })),
    },
    trialConfig: { findFirst: vi.fn(async () => null) },
  };
}

const ok = (status = 'sent') => vi.fn(async () => ({ ok: true, status }));

beforeEach(() =>
  startSettings({ app: 'worker', load: async () => [{ key: 'brand.app_url', value: 'https://app.pratibha.test' }], intervalMs: 3_600_000 })
);
afterEach(() => __resetSettingsRuntime());

describe('whatsappRecipients', () => {
  it('keeps only people with a number who opted in', () => {
    expect(whatsappRecipients(USERS).map((u) => u.id)).toEqual(['u-owner', 'u-off', 'u-removed']);
  });
});

describe('report ready on WhatsApp', () => {
  it('goes to opted-in owners and admins who left the alert on, once per call and person', async () => {
    const db = fakeDb();
    const sendWhatsApp = ok();
    const result = await notifyReportReady('call-1', { db, send: ok(), sendWhatsApp });
    expect(result).toEqual({ notified: 3, whatsapp: 1 });
    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    const [passedDb, message] = sendWhatsApp.mock.calls[0];
    expect(passedDb).toBe(db);
    expect(message).toEqual({
      kind: 'report_ready',
      tenantId: 't1',
      to: '+919800000001',
      params: ['Ananya Rao', 'Backend Engineer', 'Acme', '7.8/10', 'https://app.pratibha.test/acme/candidates/cand-9'],
      dedupeKey: 'wa_report_ready:call-1:u-owner',
    });
  });

  it('a WhatsApp failure leaves the emails counted', async () => {
    const result = await notifyReportReady('call-1', { db: fakeDb(), send: ok(), sendWhatsApp: vi.fn(async () => ({ ok: false, status: 'failed' })) });
    expect(result).toEqual({ notified: 3 });
  });

  it('the real sender, with WhatsApp not connected, logs and reaches no network', async () => {
    const db = { ...fakeDb(), whatsappLog: { create: vi.fn(async () => ({ id: 'w1' })), update: vi.fn(async () => ({})) }, whatsappOptout: { findUnique: vi.fn(async () => null) } };
    const result = await notifyReportReady('call-1', { db, send: ok() });
    expect(result).toEqual({ notified: 3 });
    expect(db.whatsappLog.update).toHaveBeenCalledWith({ where: { id: 'w1' }, data: expect.objectContaining({ status: 'failed' }) });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('minutes running low on WhatsApp', () => {
  it('sends company, minutes used and allowed, and the subscription link, keyed per level and person', async () => {
    const sendWhatsApp = ok();
    const result = await notifyQuotaIfLow({ tenantId: 't1', period: '2026-10', interviewMinutesUsed: 81.25 }, { db: fakeDb(), send: ok(), sendWhatsApp });
    expect(result).toEqual({ notified: 3, level: 'warning', whatsapp: 1 });
    expect(sendWhatsApp.mock.calls[0][1]).toEqual({
      kind: 'quota_warning',
      tenantId: 't1',
      to: '+919800000001',
      params: ['Acme', '81.3', '100', 'https://app.pratibha.test/acme/settings/subscription'],
      dedupeKey: 'wa_quota_warning:t1:2026-10:warning:u-owner',
    });
  });
});
