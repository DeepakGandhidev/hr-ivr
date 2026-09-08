import { describe, it, expect } from 'vitest';
import { isVerified } from '../src/lib/states.js';

/**
 * Who is allowed to be interviewed.
 *
 * The rule is: we know who they are (their email matched an application), they
 * have not already been interviewed, and they have chosen a language. Applying
 * to the role is the qualification — a recruiter does not have to screen,
 * shortlist and approve them first.
 */

const applicant = (over = {}) => ({
  candidate: { id: 'cand-1' },
  approved: false,
  alreadyInterviewed: false,
  language: 'en',
  ...over,
});

describe('an applicant who identified themselves', () => {
  it('may be interviewed without any recruiter approval', () => {
    expect(isVerified(applicant())).toBe(true);
  });

  it('may be interviewed in any supported language', () => {
    for (const language of ['en', 'hi', 'hinglish']) {
      expect(isVerified(applicant({ language }))).toBe(true);
    }
  });
});

describe('who is still refused', () => {
  it('refuses a caller we could not identify', () => {
    expect(isVerified(applicant({ candidate: null }))).toBe(false);
    expect(isVerified(applicant({ candidate: {} }))).toBe(false);
  });

  // Otherwise someone could call repeatedly and keep re-answering until they
  // liked their own score.
  it('refuses a candidate who has already completed an interview', () => {
    expect(isVerified(applicant({ alreadyInterviewed: true }))).toBe(false);
  });

  it('refuses before a language has been chosen', () => {
    expect(isVerified(applicant({ language: null }))).toBe(false);
  });
});

describe('strict mode, for anyone who wants the shortlist gate back', () => {
  const strict = { requireApproval: true };

  it('refuses an unapproved applicant', () => {
    expect(isVerified(applicant(), strict)).toBe(false);
  });

  it('allows an approved one', () => {
    expect(isVerified(applicant({ approved: true }), strict)).toBe(true);
  });

  it('still refuses an approved candidate who already interviewed', () => {
    expect(isVerified(applicant({ approved: true, alreadyInterviewed: true }), strict)).toBe(false);
  });
});
