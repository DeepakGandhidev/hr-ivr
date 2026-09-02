/**
 * Reconcile the conversation history with what the candidate actually heard
 * after a barge-in.
 *
 * Twilio's ConversationRelay handed this over as `utteranceUntilInterrupt`.
 * On Plivo it has to be reconstructed from checkpoint acknowledgements, and
 * getting it wrong is not cosmetic: if history claims Pratibha asked a question
 * whose audio was cut before it played, she treats it as asked and never asks
 * again, and the rubric criterion behind it goes uncovered for the rest of the
 * call. The reviewer then sees an unassessed criterion with no explanation.
 *
 * Mutates the last assistant turn in place and reports what happened.
 */
export function truncateToHeard(history, { heard, dropped }) {
  const last = history[history.length - 1];

  if (!dropped) return { changed: false, reason: 'nothing was cut' };
  if (!last || last.role !== 'assistant' || typeof last.content !== 'string') {
    return { changed: false, reason: 'last turn was not spoken text' };
  }

  if (!heard) {
    // The interruption landed before any of this reply reached them, so as far
    // as the candidate is concerned Pratibha never said it.
    history.pop();
    return { changed: true, removed: last.content, kept: '' };
  }

  const kept = heard.trim();
  if (kept === last.content.trim()) return { changed: false, reason: 'all of it was heard' };

  history[history.length - 1] = { ...last, content: kept };
  return { changed: true, kept, removed: dropped };
}
