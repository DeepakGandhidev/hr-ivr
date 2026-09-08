import { describe, it, expect } from 'vitest';
import { parseCvText } from '../src/ingestion/parser.js';

/**
 * A candidate with no phone number cannot be called, and calling is the whole
 * product. These are the ways real CVs and email signatures write an Indian
 * mobile number; the token-by-token sweep this replaced matched only the last
 * two of them.
 */
describe('phone extraction from CV text', () => {
  it.each([
    ['Phone: +91 98765 43210', '+919876543210'],
    ['Mobile: +91-98765-43210', '+919876543210'],
    ['Contact (+91) 98765 43210', '+919876543210'],
    ['Tel: +919876543210', '+919876543210'],
    ['Cell 98765 43210', '+919876543210'],
    ['Mob. 98765-43210', '+919876543210'],
    ['Phone 9876543210', '+919876543210'],
    ['Mobile: 09876543210', '+919876543210'],
  ])('reads %s', (text, expected) => {
    expect(parseCvText(text).phone).toBe(expected);
  });

  it('prefers the number over a year or a PIN code sitting nearby', () => {
    const text = 'B.Tech 2019, Pune 411045. Mobile: 98765 43210';
    expect(parseCvText(text).phone).toBe('+919876543210');
  });

  it('returns null when there is no number at all', () => {
    expect(parseCvText('Priya Sharma, React developer').phone).toBeNull();
  });

  it('does not invent a number from a landline-length string', () => {
    expect(parseCvText('Office: 020 1234 567').phone).toBeNull();
  });
});
