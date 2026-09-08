import { describe, it, expect } from 'vitest';
import { emailsMatch, normaliseSpokenEmail } from '../src/lib/emailMatch.js';

const ON_FILE = 'deepak@promonkey.tech';

describe('normaliseSpokenEmail', () => {
  it('turns spoken punctuation into symbols', () => {
    expect(normaliseSpokenEmail('deepak at the rate promonkey dot tech')).toBe('deepak@promonkey.tech');
    expect(normaliseSpokenEmail('deepak at promonkey dot tech')).toBe('deepak@promonkey.tech');
  });

  it('strips dictation artefacts', () => {
    expect(normaliseSpokenEmail('  Deepak@Promonkey.Tech.  ')).toBe('deepak@promonkey.tech');
  });
});

describe('emailsMatch', () => {
  // Every one of these is a real transcript this service produced for the
  // same address over a phone line.
  it.each([
    'deepak@promonkey.tech',
    'Deepak@promoinky.tech',
    "No, it's Deepak@at the rate promokey.".replace("No, it's ", ''),
    'deepak at the rate promonkey dot tech',
    'DEEPAK@PROMONKEY.TECH',
    'deepak@promonkey.tec',
  ])('accepts %j', (heard) => {
    expect(emailsMatch(heard, ON_FILE)).toBe(true);
  });

  it('rejects a different person on the same domain', () => {
    expect(emailsMatch('priya@promonkey.tech', ON_FILE)).toBe(false);
  });

  it('rejects a different domain entirely', () => {
    expect(emailsMatch('deepak@gmail.com', ON_FILE)).toBe(false);
  });

  it('requires an exact local part when no domain was heard', () => {
    expect(emailsMatch('deepak', ON_FILE)).toBe(true);
    expect(emailsMatch('deepaka', ON_FILE)).toBe(false);
  });

  it('rejects empty or missing input', () => {
    expect(emailsMatch('', ON_FILE)).toBe(false);
    expect(emailsMatch(null, ON_FILE)).toBe(false);
    expect(emailsMatch('deepak@promonkey.tech', null)).toBe(false);
  });
});

/**
 * Identify-by-email is the only route in for a candidate calling from a
 * different phone — a work number, a borrowed handset, a new SIM. It was
 * matching the database exactly, so a caller reading their own correct address
 * down a phone line was told they were not on the shortlist.
 */
describe('spoken addresses that must resolve to the same person', () => {
  const ON_FILE = 'ananya@example.com';

  it.each([
    'ananya@example.com',
    'ananya at the rate example dot com',
    'Ananya@example.com.',
    'ananya@exampel.com',
    'ANANYA AT THE RATE EXAMPLE DOT COM',
  ])('%j matches', (heard) => {
    expect(emailsMatch(heard, ON_FILE)).toBe(true);
  });

  it('does not match a different person on the same domain', () => {
    expect(emailsMatch('aarav at the rate example dot com', ON_FILE)).toBe(false);
  });
});

/**
 * A phone number identifies a handset, not a person. When the address a caller
 * gives belongs to a DIFFERENT approved candidate, that is a borrowed phone or
 * a reassigned SIM, not an impostor — and it is the same evidence the
 * identify-by-email path already accepts on its own. Dead-ending the call there
 * locked out a legitimate candidate who had done nothing wrong.
 */
describe('verification must distinguish three cases', () => {
  const registered = 'deepak@promonkey.tech';

  it('accepts the candidate the number is registered to', () => {
    expect(emailsMatch('deepak at the rate promonkey dot tech', registered)).toBe(true);
  });

  it('does not silently accept another address as this candidate', () => {
    // The caller is not Deepak — the fall-through has to look them up as
    // someone else rather than confirm them as the registered candidate.
    expect(emailsMatch('kabir@example.com', registered)).toBe(false);
  });

  it('matches that other address against its own owner', () => {
    expect(emailsMatch('kabir@example.com', 'kabir@example.com')).toBe(true);
    expect(emailsMatch('Kabir@example.com.', 'kabir@example.com')).toBe(true);
  });
});
