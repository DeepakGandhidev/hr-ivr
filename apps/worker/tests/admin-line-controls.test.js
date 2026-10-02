import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { TERMINAL, STATES } from '../src/lib/states.js';
import { ToolExecutor } from '../src/lib/toolExecutor.js';
import { SessionManager } from '../src/lib/sessionManager.js';
import { isTenantPaused } from '../src/lib/tenantStatus.js';

vi.mock('../src/db/index.js', () => ({
  lookupCandidateByPhone: vi.fn(),
  lookupCandidateByEmail: vi.fn(),
  recordInterviewCall: vi.fn(async () => ({ id: 'call-1' })),
  updateInterviewCall: vi.fn(async () => ({})),
  incrementInterviewUsage: vi.fn(async () => ({})),
  checkBlockedNumber: vi.fn(async () => false),
  recordUnknownCall: vi.fn(async () => ({})),
}));

import * as db from '../src/db/index.js';
import { setupRoutes } from '../src/routes/index.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const lookup = (status) => ({
  candidate: { id: 'c1', name: 'Ananya', cvParsed: {} },
  job: { id: 'j1', title: 'Field Sales Executive', mustHaves: [], goodToHaves: [], callWindows: [] },
  tenant: { id: 't1', name: 'TechServe Solutions', status },
  latestApprovedJd: null,
  interviewProtocol: null,
  approved: true,
  hasCompleted: false,
});

describe('a suspended workspace takes no interviews (C30)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('knows which statuses are paused', () => {
    expect(isTenantPaused({ status: 'suspended' })).toBe(true);
    expect(isTenantPaused({ status: 'deleted_pending' })).toBe(true);
    expect(isTenantPaused({ status: 'active' })).toBe(false);
    expect(isTenantPaused({ status: 'trial' })).toBe(false);
    expect(isTenantPaused(null)).toBe(false);
  });

  it('refuses politely when the caller identifies by email into a suspended workspace', async () => {
    db.lookupCandidateByEmail.mockResolvedValue(lookup('suspended'));
    const session = new SessionManager().create('call-1', { callerNumber: '+919000000000' });
    session.setState(STATES.IDENTIFY);
    const result = await new ToolExecutor({}, logger).execute('provide_email', { email: 'ananya@example.com' }, session);
    expect(session.outcome).toBe(TERMINAL.UNKNOWN_CALLER);
    expect(session.unknownReason.reasonCode).toBe('workspace_paused');
    expect(session.unknownReason.tenantId).toBe('t1');
    expect(result.instruction).toMatch(/paused/);
    // Never attached: nothing is recorded or billed against the workspace.
    expect(session.candidate).toBeFalsy();
    expect(db.recordInterviewCall).not.toHaveBeenCalled();
  });

  it('interviews as normal when the workspace is active', async () => {
    db.lookupCandidateByEmail.mockResolvedValue(lookup('active'));
    const session = new SessionManager().create('call-2', { callerNumber: '+919000000000' });
    session.setState(STATES.IDENTIFY);
    await new ToolExecutor({}, logger).execute('provide_email', { email: 'ananya@example.com' }, session);
    expect(session.outcome).not.toBe(TERMINAL.UNKNOWN_CALLER);
    expect(session.candidate?.id).toBe('c1');
  });
});

describe('a blocked number is refused at the line (G10)', () => {
  const config = {
    plivo: { verifySignature: false },
    operatingHours: { timezone: 'Asia/Kolkata', days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24, label: 'always' },
    maxConcurrentCalls: 10,
    publicWsUrl: 'wss://example.test/stream',
    publicBaseUrl: 'https://example.test',
  };

  async function answer(from) {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    setupRoutes(app, { config, logger, calls: new Map() });
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/pratibha/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ CallUUID: 'u1', From: from }).toString(),
      });
      return res.text();
    } finally {
      server.close();
    }
  }

  beforeEach(() => vi.clearAllMocks());

  it('hangs up on a blocked number before any stream opens', async () => {
    db.checkBlockedNumber.mockResolvedValue(true);
    const xml = await answer('919004077215');
    expect(xml).toContain('<Hangup reason="rejected"/>');
    expect(xml).not.toContain('<Stream');
    expect(db.checkBlockedNumber).toHaveBeenCalledWith('919004077215');
  });

  it('answers everyone else with the stream', async () => {
    db.checkBlockedNumber.mockResolvedValue(false);
    const xml = await answer('919811044873');
    expect(xml).toContain('<Stream');
  });

  it('answers normally if the block check itself fails', async () => {
    db.checkBlockedNumber.mockRejectedValue(new Error('db down'));
    const xml = await answer('919811044873');
    expect(xml).toContain('<Stream');
  });
});
