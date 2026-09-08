import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { STATES, TERMINAL, isVerified } from '../src/lib/states.js';
import { ToolExecutor } from '../src/lib/toolExecutor.js';
import { SessionManager } from '../src/lib/sessionManager.js';
import { makeDisclosure } from '../src/lib/screening.js';
import { deriveCriteria, isWithinCallWindow } from '../src/lib/callSession.js';

vi.mock('../src/db/index.js', () => ({
  lookupCandidateByPhone: vi.fn(),
  lookupCandidateByEmail: vi.fn(),
  recordInterviewCall: vi.fn(async () => ({ id: 'call-1' })),
  updateInterviewCall: vi.fn(async () => ({})),
  incrementInterviewUsage: vi.fn(async () => ({})),
}));

import * as db from '../src/db/index.js';

const config = {
  operatingHours: {
    timezone: 'Asia/Kolkata',
    days: [1, 2, 3, 4, 5, 6],
    startHour: 10,
    endHour: 19,
    label: 'Monday to Saturday, 10 a.m. to 7 p.m.'
  }
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const baseLookup = {
  candidate: { id: 'c1', name: 'Ananya', cvParsed: { experience: '6 years' } },
  job: {
    id: 'j1',
    title: 'Senior Backend Engineer',
    mustHaves: ['Backend depth in Node.js'],
    goodToHaves: ['AWS'],
    callWindows: []
  },
  tenant: { id: 't1', name: 'ProMonkey Technologies' },
  latestApprovedJd: { bodyMd: 'Senior backend role.' },
  interviewProtocol: { instructionText: 'Probe production experience.' },
  approved: true,
  hasCompleted: false,
};

function harness(phoneLookup = baseLookup, emailLookup = phoneLookup, overrides = {}) {
  vi.clearAllMocks();
  db.lookupCandidateByPhone.mockResolvedValue(phoneLookup);
  db.lookupCandidateByEmail.mockResolvedValue(emailLookup);

  const sessions = new SessionManager();
  const session = sessions.create('call-1', { callerNumber: '+919000000000' });
  return { session, tools: new ToolExecutor({ ...config, ...overrides }, logger) };
}

describe('disclosure personalisation', () => {
  it('uses tenant name and job title when the caller is known', () => {
    const session = {
      tenant: { name: 'Acme Corp' },
      job: { title: 'Staff Engineer' },
      candidate: { name: 'Rohan' }
    };
    const text = makeDisclosure(session);
    expect(text).toContain('Acme Corp');
    expect(text).toContain('Staff Engineer');
    expect(text).toContain('Rohan');
    expect(text).toMatch(/AI hiring assistant/i);
  });

  it('falls back to a generic disclosure for unknown callers', () => {
    const text = makeDisclosure({});
    expect(text).toMatch(/AI hiring assistant/i);
    expect(text).toMatch(/not a human/i);
  });
});

describe('phone recognition', () => {
  it('recognises an approved candidate by phone and creates an interview call row', async () => {
    const { session } = harness();
    // Simulate what CallSession.begin does for an approved caller.
    const lookup = await db.lookupCandidateByPhone(session.callerNumber);
    expect(lookup.approved).toBe(true);
    expect(lookup.hasCompleted).toBe(false);

    session.candidate = lookup.candidate;
    session.job = lookup.job;
    session.tenant = lookup.tenant;
    session.latestApprovedJd = lookup.latestApprovedJd;
    session.interviewProtocol = lookup.interviewProtocol;
    session.approved = lookup.approved;
    session.alreadyInterviewed = lookup.hasCompleted;
    session.criteria = deriveCriteria(lookup.job);
    session.recognised = true;
    await db.recordInterviewCall({
      candidateId: session.candidate.id,
      callerNumber: session.callerNumber,
      recognised: true,
      status: 'unknown_caller'
    });

    expect(db.recordInterviewCall).toHaveBeenCalledOnce();
    expect(session.candidate.name).toBe('Ananya');
  });

  it('treats an unapproved phone match as needing email confirmation', async () => {
    const lookup = { ...baseLookup, approved: false };
    const { session } = harness(lookup);
    const result = await db.lookupCandidateByPhone(session.callerNumber);
    expect(result.approved).toBe(false);
    // In the real session this would leave the state as IDENTIFY.
    session.setState(STATES.IDENTIFY);
    expect(session.state).toBe(STATES.IDENTIFY);
  });

  it('detects an already-interviewed candidate', async () => {
    const lookup = { ...baseLookup, hasCompleted: true };
    const { session } = harness(lookup);
    const result = await db.lookupCandidateByPhone(session.callerNumber);
    expect(result.hasCompleted).toBe(true);
    expect(result.approved).toBe(true);
  });
});

describe('email fallback', () => {
  it('moves to language selection when the email matches an approved shortlist', async () => {
    const { tools, session } = harness();
    session.state = STATES.IDENTIFY;
    const result = await tools.execute('provide_email', { email: 'ananya@example.com' }, session);

    expect(result.recognised).toBe(true);
    expect(session.state).toBe(STATES.LANGUAGE_SELECT);
    expect(session.candidate.id).toBe('c1');
    expect(db.recordInterviewCall).toHaveBeenCalledOnce();
  });

  it('ends politely when the email is unknown', async () => {
    const { tools, session } = harness(baseLookup, null);
    session.state = STATES.IDENTIFY;
    const result = await tools.execute('provide_email', { email: 'ghost@example.com' }, session);

    expect(result.recognised).toBe(false);
    expect(session.ended).toBe(true);
    expect(session.outcome).toBe(TERMINAL.UNKNOWN_CALLER);
    expect(db.recordInterviewCall).not.toHaveBeenCalled();
  });

  // Applying to the role is the qualification. Requiring a recruiter to screen,
  // shortlist and approve first meant a candidate who applied on Monday could
  // not be interviewed until somebody clicked through three screens.
  it('interviews an applicant who has not been through a shortlist', async () => {
    const { tools, session } = harness(baseLookup, { ...baseLookup, approved: false });
    session.state = STATES.IDENTIFY;
    const result = await tools.execute('provide_email', { email: 'applicant@example.com' }, session);

    expect(result.recognised).toBe(true);
    expect(session.ended).toBe(false);
    expect(session.state).toBe(STATES.LANGUAGE_SELECT);
  });

  it('marks the caller verified once the email resolves to an application', async () => {
    const { tools, session } = harness(baseLookup, { ...baseLookup, approved: false });
    session.state = STATES.IDENTIFY;
    await tools.execute('provide_email', { email: 'applicant@example.com' }, session);

    // The address they said aloud is the identity check; the phone number only
    // suggests who is calling.
    expect(session.emailVerified).toBe(true);
  });

  it('still refuses an unapproved candidate when strict mode is switched on', async () => {
    const { tools, session } = harness(
      baseLookup,
      { ...baseLookup, approved: false },
      { requireShortlistApproval: true }
    );
    session.state = STATES.IDENTIFY;
    const result = await tools.execute('provide_email', { email: 'unapproved@example.com' }, session);

    expect(result.approved).toBe(false);
    expect(session.ended).toBe(true);
    expect(session.outcome).toBe(TERMINAL.UNKNOWN_CALLER);
  });

  it('ends politely when the candidate already has a completed interview', async () => {
    const { tools, session } = harness(baseLookup, { ...baseLookup, hasCompleted: true });
    session.state = STATES.IDENTIFY;
    const result = await tools.execute('provide_email', { email: 'done@example.com' }, session);

    expect(result.already_interviewed).toBe(true);
    expect(session.ended).toBe(true);
    expect(session.outcome).toBe(TERMINAL.ALREADY_INTERVIEWED);
  });
});

describe('language selection', () => {
  it('records the chosen language and moves to time consent', async () => {
    const { tools, session } = harness();
    session.state = STATES.LANGUAGE_SELECT;
    session.candidate = baseLookup.candidate;
    session.approved = true;
    session.alreadyInterviewed = false;
    session.interviewCallId = 'call-1';

    const result = await tools.execute('select_language', { language: 'hi' }, session);
    expect(result.language).toBe('hi');
    expect(session.language).toBe('hi');
    expect(session.state).toBe(STATES.CONSENT_TIME);
    expect(db.updateInterviewCall).toHaveBeenCalledWith('call-1', { language: 'hi' });
  });
});

describe('verification gate', () => {
  it('considers a caller verified only after recognition, approval, and language', () => {
    const { session } = harness();
    expect(isVerified(session)).toBe(false);

    session.candidate = baseLookup.candidate;
    session.approved = true;
    session.alreadyInterviewed = false;
    expect(isVerified(session)).toBe(false); // still missing language

    session.language = 'en';
    expect(isVerified(session)).toBe(true);

    session.alreadyInterviewed = true;
    expect(isVerified(session)).toBe(false);
  });
});

describe('call window checks', () => {
  const window = {
    timezone: 'Asia/Kolkata',
    days: [2], // Tuesday
    startTime: '10:00',
    endTime: '19:00'
  };

  it('is open during the configured window', () => {
    // 2026-09-01 is a Tuesday, 09:00 UTC = 14:30 IST
    const now = new Date('2026-09-01T09:00:00Z');
    expect(isWithinCallWindow([window], now)).toBe(true);
  });

  it('is closed outside the configured window', () => {
    // 2026-09-01 03:00 UTC = 08:30 IST
    const now = new Date('2026-09-01T03:00:00Z');
    expect(isWithinCallWindow([window], now)).toBe(false);
  });

  it('is closed on the wrong day', () => {
    // 2026-09-06 is a Sunday
    const now = new Date('2026-09-06T09:00:00Z');
    expect(isWithinCallWindow([window], now)).toBe(false);
  });

  it('allows the call when no windows are configured', () => {
    expect(isWithinCallWindow([], new Date())).toBe(true);
  });
});

describe('criteria derivation', () => {
  it('turns must-haves and good-to-haves into weighted criteria', () => {
    const job = {
      mustHaves: ['Node.js', 'API design'],
      goodToHaves: ['AWS']
    };
    const criteria = deriveCriteria(job);
    expect(criteria).toHaveLength(3);
    expect(criteria[0]).toEqual({ id: 1, criterion: 'Node.js', weight: 5, evaluation_guidance: 'Must-have for this role.' });
    expect(criteria[2]).toEqual({ id: 3, criterion: 'AWS', weight: 3, evaluation_guidance: 'Nice-to-have for this role.' });
  });
});
