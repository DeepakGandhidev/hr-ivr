import { describe, it, expect } from 'vitest';
import { stripUnstorable } from '../src/ingestion/extractText.js';
import { parseCvText } from '../src/ingestion/parser.js';

/**
 * The regression: a real CV in a real inbox carried a NUL byte, Postgres
 * rejected the insert with 22P05 ("\u0000 cannot be converted to text"), and
 * because the poller holds its UID watermark on failure, that one message
 * stalled the 28 behind it. One malformed PDF stopped the whole mailbox.
 */
describe('stripUnstorable', () => {
  it('removes the NUL byte Postgres rejects', () => {
    expect(stripUnstorable('Deepak\u0000Kumar')).toBe('DeepakKumar');
  });

  it('removes other C0 control characters', () => {
    expect(stripUnstorable('a\u0001b\u0007c\u001Fd\u007Fe')).toBe('abcde');
  });

  it('keeps tab, newline and carriage return, which carry layout', () => {
    expect(stripUnstorable('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('keeps ordinary and non-Latin text intact', () => {
    expect(stripUnstorable('Priya Sharma — प्रिया — 5 yrs')).toBe('Priya Sharma — प्रिया — 5 yrs');
  });

  it('removes unpaired surrogates but keeps valid pairs', () => {
    expect(stripUnstorable('a\uD800b')).toBe('ab');
    expect(stripUnstorable('a\uDC00b')).toBe('ab');
    // A valid pair is one real character (an emoji) and must survive.
    expect(stripUnstorable('ok 😀')).toBe('ok 😀');
  });

  it('handles null and undefined', () => {
    expect(stripUnstorable(null)).toBe('');
    expect(stripUnstorable(undefined)).toBe('');
  });
});

describe('parseCvText sanitises its own input', () => {
  // parseCvText is reached directly with raw email-body text, which is not
  // routed through the PDF extractor and carries the same bytes.
  it('produces no NUL anywhere in the parsed output', () => {
    const parsed = parseCvText(
      'Deepak\u0000 Kumar\ndeepak\u0000@promonkey.tech\nPhone: 98765 43210\nSkills: React\u0000, Node.js'
    );

    const serialised = JSON.stringify(parsed);
    expect(serialised).not.toContain('\\u0000');
    expect(serialised.includes('\u0000')).toBe(false);
  });

  it('still extracts the fields correctly around the stripped bytes', () => {
    const parsed = parseCvText('Anil Verma\u0000\nanil@example.com\nMobile: +91 98765 43210');
    expect(parsed.email).toBe('anil@example.com');
    expect(parsed.phone).toBe('+919876543210');
  });
});
