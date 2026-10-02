import { describe, it, expect } from 'vitest';
import { isBillableInterview, deriveCallStatus } from '../src/lib/callSession.js';
import { TERMINAL } from '../src/lib/states.js';

const base = { status: 'completed', recognised: true, producesReport: true, tenantId: 't1' };

describe('isBillableInterview — §2.8', () => {
  it('bills a completed call by a recognised candidate that produced a report', () => {
    expect(isBillableInterview(base)).toBe(true);
  });

  // Each of these used to increment the meter: everything except an unknown
  // caller was billed, so a tenant paid ₹149 for calls that dropped in the
  // first ten seconds and produced no report.
  it('does not bill a mid-call drop', () => {
    expect(isBillableInterview({ ...base, status: 'dropped', producesReport: false })).toBe(false);
  });

  it('does not bill an out-of-window call-back', () => {
    expect(isBillableInterview({ ...base, status: 'out_of_window', producesReport: false })).toBe(false);
  });

  it('does not bill a consent decline', () => {
    expect(isBillableInterview({ ...base, status: 'declined_consent', producesReport: false })).toBe(false);
  });

  it('does not bill an unknown caller', () => {
    expect(isBillableInterview({ ...base, status: 'unknown_caller', recognised: false, producesReport: false })).toBe(false);
  });

  // A repeat caller is short-circuited before any question is asked, so no
  // report is produced — §5 Stage 8 "Not billed twice".
  it('does not bill a repeat call by an already-interviewed candidate', () => {
    expect(isBillableInterview({ ...base, producesReport: false })).toBe(false);
  });

  it('does not bill a completed call that somehow produced no report', () => {
    expect(isBillableInterview({ ...base, producesReport: false })).toBe(false);
  });

  it('does not bill without a tenant', () => {
    expect(isBillableInterview({ ...base, tenantId: undefined })).toBe(false);
  });
});

describe('deriveCallStatus', () => {
  it('maps each terminal outcome to a stored status', () => {
    expect(deriveCallStatus({ outcome: TERMINAL.COMPLETED })).toBe('completed');
    expect(deriveCallStatus({ outcome: TERMINAL.ABANDONED })).toBe('dropped');
    expect(deriveCallStatus({ outcome: TERMINAL.UNKNOWN_CALLER })).toBe('unknown_caller');
    expect(deriveCallStatus({ outcome: TERMINAL.OUT_OF_WINDOW })).toBe('out_of_window');
    expect(deriveCallStatus({ outcome: TERMINAL.DECLINED_CONSENT })).toBe('declined_consent');
  });

  it('falls back to dropped for an unrecognised outcome', () => {
    expect(deriveCallStatus({ outcome: 'something_new' })).toBe('dropped');
  });
});
