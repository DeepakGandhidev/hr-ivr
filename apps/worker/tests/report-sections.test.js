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
