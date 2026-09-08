/**
 * Compare an email a candidate said out loud against the one on their
 * application.
 *
 * Spoken email addresses survive an 8 kHz phone line badly. Real transcripts
 * from this service include "Deepak@at the rate promokey", "deepak@yahoo.com"
 * and "Deepak@promoinky.tech" for the same address, so an exact string compare
 * rejects the genuine candidate almost every time. This normalises the ways
 * people say an address, then allows a small amount of character damage.
 */

export function normaliseSpokenEmail(raw) {
  let s = String(raw ?? '').trim().toLowerCase();

  // "at the rate" is how the "@" is read aloud in India. It often arrives with
  // a literal "@" already in front of it ("Deepak@at the rate promokey"),
  // because the recogniser transcribes the symbol and then the words for it, so
  // the optional leading @ has to be swallowed too.
  s = s.replace(/@?\s*\bat\s+the\s+rate\b\s*(of\b\s*)?/g, '@');
  s = s.replace(/@?\s*\bat\s+sign\b\s*/g, '@');
  // A bare "at" is only the symbol when nothing else supplied one — otherwise
  // it is a word in the address or a stray filler.
  if (!s.includes('@')) s = s.replace(/\s+\bat\b\s+/g, '@');

  s = s.replace(/\s*\bdot\b\s*/g, '.');
  s = s.replace(/\s*\bunderscore\b\s*/g, '_');
  s = s.replace(/\s*\b(dash|hyphen)\b\s*/g, '-');

  // Whitespace and trailing sentence punctuation are dictation artefacts,
  // never part of an address.
  s = s.replace(/\s+/g, '').replace(/[.,;:!?]+$/, '').replace(/@{2,}/g, '@');
  return s;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

function close(a, b, tolerance) {
  if (!a || !b) return false;
  if (a === b) return true;
  return levenshtein(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) * tolerance));
}

/**
 * The local part carries the identity; the domain is the part STT mangles most
 * ("promonkey" -> "promoinky", "promokey"), and it is also the part an impostor
 * is least likely to guess wrong in a meaningful way. So the local part is held
 * to a tighter bar than the domain, and a confident local-part match with a
 * recognisable domain is accepted.
 */
export function emailsMatch(spoken, onFile) {
  const said = normaliseSpokenEmail(spoken);
  const actual = normaliseSpokenEmail(onFile);
  if (!said || !actual) return false;
  if (said === actual) return true;

  const [saidLocal, saidDomain = ''] = said.split('@');
  const [actualLocal, actualDomain = ''] = actual.split('@');

  const localOk = close(saidLocal, actualLocal, 0.2);
  if (!localOk) return false;

  // No domain heard at all — the caller said just their username. The local
  // part alone is weak, so require it to be exact.
  if (!saidDomain) return saidLocal === actualLocal;

  // Compare the domain without its TLD: ".tech" reliably comes through as
  // ".tec", ".take" or nothing at all.
  const stem = (d) => d.split('.')[0];
  return close(saidDomain, actualDomain, 0.34) || close(stem(saidDomain), stem(actualDomain), 0.34);
}
