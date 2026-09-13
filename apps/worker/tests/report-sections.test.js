import { describe, it, expect } from 'vitest';
import { pairQuestionsAndAnswers } from '../src/lib/analysis.js';

describe('pairQuestionsAndAnswers', () => {
  it('pairs each question with the answer that followed it', () => {
    const pairs = pairQuestionsAndAnswers([
      { speaker: 'pratibha', text: 'Tell me about your last role.', atMs: 1000 },
      { speaker: 'candidate', text: 'I led a team of six.', atMs: 4000 },
      { speaker: 'pratibha', text: 'What was the hardest part?', atMs: 9000 },
      { speaker: 'candidate', text: 'Hiring under a freeze.', atMs: 12000 },
    ]);

    expect(pairs).toEqual([
      { question: 'Tell me about your last role.', answer: 'I led a team of six.', atMs: 1000 },
      { question: 'What was the hardest part?', answer: 'Hiring under a freeze.', atMs: 9000 },
    ]);
  });

  // The greeting and the closing are turns she takes without a reply. They are
  // in the transcript; section 2 is for the questions.
  it('drops turns that got no answer', () => {
    const pairs = pairQuestionsAndAnswers([
      { speaker: 'pratibha', text: 'Hello, this is Pratibha.', atMs: 0 },
      { speaker: 'pratibha', text: 'Shall we begin?', atMs: 500 },
      { speaker: 'candidate', text: 'Yes.', atMs: 2000 },
      { speaker: 'pratibha', text: 'Thank you, have a good day.', atMs: 30000 },
    ]);

    expect(pairs).toEqual([
      { question: 'Shall we begin?', answer: 'Yes.', atMs: 500 },
    ]);
  });

  it('returns nothing for an empty transcript', () => {
    expect(pairQuestionsAndAnswers([])).toEqual([]);
  });

  it('ignores a candidate turn with no question before it', () => {
    expect(pairQuestionsAndAnswers([
      { speaker: 'candidate', text: 'Hello?', atMs: 0 },
    ])).toEqual([]);
  });
});

/**
 * #validate returns a fresh whitelisted object rather than a copy of the
 * model's input, so any field it does not name is silently discarded. All five
 * report fields were dropped that way on the first live call after they were
 * added: the report saved with question_answers populated (derived locally) and
 * every model-sourced section null.
 *
 * Asserted on the source because the whitelist is the failure: a mock would
 * pass whatever the test supplied straight through and prove nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('the assessment whitelist carries the report sections', () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/analysis.js'),
    'utf8'
  );
  const validateReturn = src.slice(src.indexOf('const recommendation = INTERNAL_RECOMMENDATIONS'));

  for (const field of [
    'interview_score',
    'interview_score_reasoning',
    'jd_fit_summary',
    'recommendation_score',
    'recommendation_verdict',
  ]) {
    it(`passes ${field} through`, () => {
      expect(validateReturn).toContain(`${field}:`);
    });
  }

  it('asks the model for every field it then reads', () => {
    // The tool schema's TOP-LEVEL required list - the one naming 'scores' -
    // not the nested per-score one that appears earlier in the file.
    const start = src.indexOf("required: [\n      'scores'");
    expect(start).toBeGreaterThan(-1);
    const required = src.slice(start, src.indexOf(']', start));

    expect(required).toContain('interview_score');
    expect(required).toContain('recommendation_score');
    expect(required).toContain('jd_fit_summary');
  });
});
