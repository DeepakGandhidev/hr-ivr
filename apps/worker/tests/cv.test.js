import { describe, it, expect } from 'vitest';
import { cvList } from '../src/lib/cv.js';

describe('cvList', () => {
  it('passes an array of strings through, trimmed', () => {
    expect(cvList(['Node.js', ' PostgreSQL '])).toEqual(['Node.js', 'PostgreSQL']);
  });

  // The regression: a parsed CV with education as a plain string used to throw
  // "(cv.education ?? []).join is not a function" on the first model turn,
  // ending a live interview before the first question.
  it('wraps a bare string into a single-entry list', () => {
    expect(cvList('B.E. IT')).toEqual(['B.E. IT']);
  });

  it('returns an empty list for null, undefined and empty strings', () => {
    expect(cvList(null)).toEqual([]);
    expect(cvList(undefined)).toEqual([]);
    expect(cvList('   ')).toEqual([]);
  });

  it('flattens object entries into something speakable', () => {
    expect(cvList([{ degree: 'B.Tech', institution: 'NIT Trichy', year: 2019 }]))
      .toEqual(['B.Tech NIT Trichy 2019']);
  });

  it('drops empty entries rather than emitting blanks', () => {
    expect(cvList(['Node.js', '', null, 'Redis'])).toEqual(['Node.js', 'Redis']);
  });

  it('coerces numbers', () => {
    expect(cvList(5)).toEqual(['5']);
  });
});
