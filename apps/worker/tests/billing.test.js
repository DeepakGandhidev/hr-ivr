import { describe, it, expect } from 'vitest';
import { deriveCallStatus } from '../src/lib/callSession.js';
import { isBillableCall, billableMinutes } from '@pratibha/shared';
import { TERMINAL } from '../src/lib/states.js';

// One rule, in @pratibha/shared, so the worker that charges and the UI that
// reports cannot disagree about what is billable. `minutes` joined the test
// when pricing moved from per-interview to per-minute.
const base = {
  status: 'completed',
  recognised: true,
  producesReport: true,
  tenantId: 't1',
  minutes: 12,
};

describe('isBillableCall — §2.8', () => {
  it('bills a completed call by a recognised candidate that produced a report', () => {
    expect(isBillableCall(base)).toBe(true);
  });

  // Each of these used to increment the meter: everything except an unknown
  // caller was billed, so a tenant paid ₹149 for calls that dropped in the
  // first ten seconds and produced no report.
  it('does not bill a mid-call drop', () => {
    expect(isBillableCall({ ...base, status: 'dropped', producesReport: false })).toBe(false);
  });

  it('does not bill an out-of-window call-back', () => {
    expect(isBillableCall({ ...base, status: 'out_of_window', producesReport: false })).toBe(false);
  });

  it('does not bill a consent decline', () => {
    expect(isBillableCall({ ...base, status: 'declined_consent', producesReport: false })).toBe(false);
  });

  it('does not bill an unknown caller', () => {
    expect(isBillableCall({ ...base, status: 'unknown_caller', recognised: false, producesReport: false })).toBe(false);
  });

  // A repeat caller is short-circuited before any question is asked, so no
  // report is produced — §5 Stage 8 "Not billed twice".
  it('does not bill a repeat call by an already-interviewed candidate', () => {
    expect(isBillableCall({ ...base, producesReport: false })).toBe(false);
  });

  it('does not bill a completed call that somehow produced no report', () => {
    expect(isBillableCall({ ...base, producesReport: false })).toBe(false);
  });

  it('does not bill without a tenant', () => {
    expect(isBillableCall({ ...base, tenantId: undefined })).toBe(false);
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

  // Production recorded every interview but one as `dropped`: the model says
  // goodbye without calling end_call, nothing hangs up, and the caller-side
  // hangup reaches finish() with no outcome - which defaults to ABANDONED.
  // Ten-question interviews were going unbilled and were shown to the recruiter
  // as failed calls.
  it('counts an abandon after finish_screening as a completed interview', () => {
    expect(deriveCallStatus({
      outcome: TERMINAL.ABANDONED,
      screeningFinished: true,
      questionsAsked: 10,
    })).toBe('completed');
  });

  it('still drops an abandon before the screening finished', () => {
    expect(deriveCallStatus({
      outcome: TERMINAL.ABANDONED,
      screeningFinished: false,
      questionsAsked: 2,
    })).toBe('dropped');
  });

  // finish_screening set the flag but no question was ever put - there is no
  // interview to bill for, whatever the tool reported.
  it('drops an abandon that asked nothing', () => {
    expect(deriveCallStatus({
      outcome: TERMINAL.ABANDONED,
      screeningFinished: true,
      questionsAsked: 0,
    })).toBe('dropped');
  });
});
