// Claude writes markdown by habit and a TTS engine reads it literally - "**six
// years**" comes out as "asterisk asterisk six years asterisk asterisk". Every
// string bound for the candidate's ear goes through here first.
const MARKDOWN = [
  [/```[\s\S]*?```/g, ' '],
  [/`([^`]+)`/g, '$1'],
  [/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1'],
  [/(\*\*\*|___)([\s\S]*?)\1/g, '$2'],
  [/(\*\*|__)([\s\S]*?)\1/g, '$2'],
  [/(?<![A-Za-z0-9])([*_])(\S[\s\S]*?\S|\S)\1(?![A-Za-z0-9])/g, '$2'],
  [/~~([\s\S]*?)~~/g, '$1'],
  [/^\s{0,3}#{1,6}\s+/gm, ''],
  [/^\s{0,3}>\s?/gm, ''],
  [/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/gm, ''],
  [/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '']
];

export function toSpeech(text) {
  if (text === null || text === undefined) return '';

  let out = String(text);
  for (const [pattern, replacement] of MARKDOWN) out = out.replace(pattern, replacement);

  out = out.replace(/[*`~]/g, '');
  out = out.replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, '');
  out = out.replace(/#+(?=\s|$)/g, '');

  return out.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Split a reply into sentences, because each one is synthesised and checkpointed
 * separately. That buys two things: the first sentence starts playing while the
 * rest is still being synthesised, and a barge-in can be resolved to sentence
 * granularity - we know exactly which sentences the candidate actually heard,
 * which is the fact the conversation history has to be honest about.
 *
 * Abbreviations and decimals must not split, or "6.5 years" becomes two
 * utterances with a checkpoint in the middle of the number.
 */
const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Ltd|Pvt|Inc|Co|vs|etc|i\.e|e\.g|a\.m|p\.m)\.$/i;

export function splitSentences(text, maxChars = 220) {
  const clean = toSpeech(text);
  if (!clean) return [];

  const parts = [];
  let current = '';

  for (const token of clean.split(/(?<=[.!?])\s+/)) {
    const candidate = current ? `${current} ${token}` : token;

    // A break right after an abbreviation or a decimal point is a false one.
    if (ABBREVIATIONS.test(current) || /\d\.$/.test(current)) {
      current = candidate;
      continue;
    }
    if (current) {
      parts.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);

  // A sentence longer than the cap delays first audio and makes barge-in
  // coarse, so break it at a comma or, failing that, at a word boundary.
  const out = [];
  for (const part of parts) {
    let rest = part.trim();
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars);
      const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' '));
      const at = cut > maxChars * 0.4 ? cut + 1 : maxChars;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * Pull every finished sentence out of a buffer that is still growing, leaving
 * the unfinished tail behind.
 *
 * This is what lets synthesis start while the model is still writing: a
 * sentence goes to the vendor the moment it is complete rather than the whole
 * reply waiting on the last token. The tail comes back raw - never through
 * toSpeech - because the next delta is appended straight onto it, and
 * normalising it early would eat the space between two words.
 */
export function takeSentences(buffer, maxChars = 220) {
  // A terminator only ends a sentence when whitespace follows it. Without that
  // rule the model writing "3." ends a sentence every time it says a decimal,
  // and half a number gets spoken on its own.
  const boundary = /[.!?]["'\u201D\u2019)\]]*\s/g;
  let cut = 0;
  let match;

  while ((match = boundary.exec(buffer))) {
    const end = match.index + match[0].length;
    const head = buffer.slice(0, end).trimEnd();
    // The same false breaks splitSentences guards against. They matter more
    // here: the text that would disprove them has not been written yet.
    if (ABBREVIATIONS.test(head) || /\d\.$/.test(head)) continue;
    cut = end;
  }

  if (cut) return { sentences: splitSentences(buffer.slice(0, cut)), rest: buffer.slice(cut) };

  // No sentence has ended yet, but a long enough clause still has to start
  // playing or a rambling opening line puts the caller back into silence for
  // the whole time it takes to write.
  if (buffer.length >= maxChars) {
    const window = buffer.slice(0, maxChars);
    const at = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' '));
    if (at > maxChars * 0.4) {
      return { sentences: splitSentences(buffer.slice(0, at + 1)), rest: buffer.slice(at + 1) };
    }
  }

  return { sentences: [], rest: buffer };
}
