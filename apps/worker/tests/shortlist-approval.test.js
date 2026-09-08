import { describe, it, expect } from 'vitest';
import { isApprovedFromRecord } from '../src/db/index.js';

/**
 * The contract between the web app's "Approve shortlist" button and the agent's
 * caller check.
 *
 * A candidate is allowed to be interviewed only when BOTH halves are written:
 *   - their shortlist item carries finalState 'approved', and
 *   - the shortlist has an approval whose snapshot names them.
 *
 * The approve endpoint used to write only the second half, so every approved
 * candidate was still refused on the phone. These tests fail if either half
 * stops being written.
 */

const approvedCandidate = (over = {}) => ({
  id: 'cand-1',
  shortlistItems: [
    {
      finalState: 'approved',
      shortlist: { approvals: [{ snapshot: [{ candidateId: 'cand-1', name: 'Priya' }] }] },
    },
  ],
  ...over,
});

describe('a candidate cleared to be interviewed', () => {
  it('is approved when the item and the snapshot agree', () => {
    expect(isApprovedFromRecord(approvedCandidate())).toBe(true);
  });

  it('accepts a snapshot of bare id strings', () => {
    const candidate = approvedCandidate({
      shortlistItems: [
        { finalState: 'approved', shortlist: { approvals: [{ snapshot: ['cand-1'] }] } },
      ],
    });
    expect(isApprovedFromRecord(candidate)).toBe(true);
  });

  it('accepts a snapshot keyed by candidateIds', () => {
    const candidate = approvedCandidate({
      shortlistItems: [
        { finalState: 'approved', shortlist: { approvals: [{ snapshot: { candidateIds: ['cand-1'] } }] } },
      ],
    });
    expect(isApprovedFromRecord(candidate)).toBe(true);
  });
});

describe('a candidate who must NOT be interviewed', () => {
  // The exact regression: the approval existed, but the item was left at null
  // because the endpoint never wrote finalState.
  it('is refused when the snapshot names them but finalState was never set', () => {
    const candidate = approvedCandidate({
      shortlistItems: [
        { finalState: null, shortlist: { approvals: [{ snapshot: [{ candidateId: 'cand-1' }] }] } },
      ],
    });
    expect(isApprovedFromRecord(candidate)).toBeFalsy();
  });

  // The mirror case: an empty snapshot, which is what the broken
  // `not: 'removed'` filter produced for freshly added items.
  it('is refused when the item is approved but the snapshot is empty', () => {
    const candidate = approvedCandidate({
      shortlistItems: [{ finalState: 'approved', shortlist: { approvals: [{ snapshot: [] }] } }],
    });
    expect(isApprovedFromRecord(candidate)).toBeFalsy();
  });

  it('is refused when the snapshot names somebody else', () => {
    const candidate = approvedCandidate({
      shortlistItems: [
        { finalState: 'approved', shortlist: { approvals: [{ snapshot: [{ candidateId: 'someone-else' }] }] } },
      ],
    });
    expect(isApprovedFromRecord(candidate)).toBeFalsy();
  });

  it('is refused when the shortlist was never approved at all', () => {
    const candidate = approvedCandidate({
      shortlistItems: [{ finalState: 'approved', shortlist: { approvals: [] } }],
    });
    expect(isApprovedFromRecord(candidate)).toBeFalsy();
  });

  it('is refused after being removed from the shortlist', () => {
    const candidate = approvedCandidate({
      shortlistItems: [
        { finalState: 'removed', shortlist: { approvals: [{ snapshot: [{ candidateId: 'cand-1' }] }] } },
      ],
    });
    expect(isApprovedFromRecord(candidate)).toBeFalsy();
  });

  it('is refused when they are on no shortlist', () => {
    expect(isApprovedFromRecord({ id: 'cand-1', shortlistItems: [] })).toBeFalsy();
    expect(isApprovedFromRecord({ id: 'cand-1' })).toBeFalsy();
  });
});
