import { describe, it, expect } from 'vitest';
import {
  billableMinutes,
  isBillableCall,
  approximateInterviews,
  quotaState,
} from '@pratibha/shared';

const at = (mins, secs = 0) => new Date(Date.UTC(2026, 8, 14, 10, mins, secs));

describe('billableMinutes', () => {
  // Gaurav's acceptance: "a 12-minute call consumes 12 minutes".
  it('charges a twelve-minute interview twelve minutes', () => {
    expect(billableMinutes(at(0), at(12))).toBe(12);
  });

  it('rounds every part-minute up', () => {
    expect(billableMinutes(at(0), at(1, 1))).toBe(2);
    expect(billableMinutes(at(0), at(0, 1))).toBe(1);
    expect(billableMinutes(at(0), at(9, 59))).toBe(10);
  });

  /**
   * The clock starts at the first question, not when the phone was answered.
   * Greeting, disclosure, identity and both consent steps are unbilled - that
   * is what the Interview settings screen tells customers.
   */
  it('does not charge for the greeting and consent that preceded the first question', () => {
    // Call connected at :00, first question at :04, ended at :16.
    expect(billableMinutes(at(4), at(16))).toBe(12);
  });

  // Gaurav's acceptance: "a wrong-number call consumes none".
  it('charges nothing when no question was ever asked', () => {
    expect(billableMinutes(null, at(9))).toBe(0);
    expect(billableMinutes(undefined, at(9))).toBe(0);
  });

  it('charges nothing for a call with no end', () => {
    expect(billableMinutes(at(0), null)).toBe(0);
  });

  it('never returns a negative charge', () => {
    expect(billableMinutes(at(10), at(2))).toBe(0);
  });

  it('accepts ISO strings as well as dates', () => {
    expect(billableMinutes(at(0).toISOString(), at(5).toISOString())).toBe(5);
  });
});

describe('isBillableCall', () => {
  const base = {
    status: 'completed',
    recognised: true,
    producesReport: true,
    tenantId: 't1',
    minutes: 12,
  };

  it('bills a completed interview that produced a report', () => {
    expect(isBillableCall(base)).toBe(true);
  });

  // The unit changed; who is exempt did not.
  it('never bills a wrong number, a drop, an out-of-window call or a consent decline', () => {
    expect(isBillableCall({ ...base, status: 'unknown_caller', recognised: false })).toBe(false);
    expect(isBillableCall({ ...base, status: 'dropped' })).toBe(false);
    expect(isBillableCall({ ...base, status: 'out_of_window' })).toBe(false);
    expect(isBillableCall({ ...base, status: 'declined_consent' })).toBe(false);
  });

  it('does not bill a completed call that reached no question', () => {
    expect(isBillableCall({ ...base, minutes: 0 })).toBe(false);
  });
});

describe('approximateInterviews', () => {
  it('converts remaining minutes into roughly how many interviews are left', () => {
    expect(approximateInterviews(238, 7)).toBe(34);
    expect(approximateInterviews(100, 10)).toBe(10);
  });

  it('never promises a fraction of an interview', () => {
    expect(approximateInterviews(19, 10)).toBe(1);
    expect(approximateInterviews(5, 10)).toBe(0);
  });

  it('handles an exhausted quota', () => {
    expect(approximateInterviews(0)).toBe(0);
    expect(approximateInterviews(-20)).toBe(0);
  });
});

describe('quotaState', () => {
  // Gaurav's acceptance: "I get a warning at 80%".
  it('warns at eighty percent', () => {
    expect(quotaState(79, 100).level).toBe(null);
    expect(quotaState(80, 100).level).toBe('warning');
    expect(quotaState(99, 100).level).toBe('warning');
  });

  it('reports exhaustion at and beyond the limit', () => {
    expect(quotaState(100, 100).level).toBe('exhausted');
    expect(quotaState(140, 100).level).toBe('exhausted');
  });

  it('reports remaining minutes, never below zero', () => {
    expect(quotaState(412, 650).remaining).toBe(238);
    expect(quotaState(700, 650).remaining).toBe(0);
  });

  it('treats an unmetered plan as having no limit rather than a limit of zero', () => {
    const state = quotaState(500, null);
    expect(state.limit).toBe(null);
    expect(state.remaining).toBe(null);
    expect(state.level).toBe(null);
  });
});
