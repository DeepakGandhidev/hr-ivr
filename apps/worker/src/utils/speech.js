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
