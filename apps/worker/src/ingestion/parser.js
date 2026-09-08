import { extractText, stripUnstorable } from './extractText.js';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function normalizePhoneE164(raw, defaultCountryCode = '+91') {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  if (!digits || digits.length < 10) return null;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `${defaultCountryCode}${digits}`;
  if (digits.length > 10 && digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 11) return `${defaultCountryCode}${digits.slice(1)}`;
  if (String(raw ?? '').startsWith('+')) return `+${digits}`;
  return null;
}

function extractPrintableText(buffer) {
  // Convert to a lossy string, then keep printable ASCII plus common Indic
  // punctuation and whitespace. This is intentionally lightweight: P0 ingestion
  // is allowed to be rough as long as it yields enough signal for screening.
  const text = buffer.toString('binary');
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    // Keep tab, newline, carriage return; drop other ASCII control chars.
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      out += ' ';
      continue;
    }
    // Keep printable ASCII, Indic scripts, and a few punctuation marks.
    if (
      code <= 126 ||
      (code >= 0x0900 && code <= 0x097F) ||
      code === 0x2013 ||
      code === 0x2014
    ) {
      out += ch;
      continue;
    }
    out += ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}

function pickName(text) {
  const patterns = [
    /name\s*[-:]\s*([A-Z][A-Za-z\s]+?)(?=\n|\s{2,}|\s*\p{P})/u,
    /(?:i am|my name is)\s+([A-Z][A-Za-z\s]+?)(?=\.|,|\n|\s{2,})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  // First reasonable line of the body.
  const first = text.split(/\n|\s{2,}/).find((line) => line.trim().length > 3 && /^[A-Za-z]/.test(line.trim()));
  return first ? first.trim().slice(0, 60) : null;
}

function pickExperience(text) {
  const m = text.match(/(\d+)\+?\s*(?:years?|yrs?)(?:\s+of\s+experience)?/i);
  if (m) return `${m[1]} years`;
  const m2 = text.match(/(?:experience)\s*[-:]?\s*(\d+)\+?\s*years?/i);
  if (m2) return `${m2[1]} years`;
  return null;
}

function pickSkills(text) {
  const skillBank = [
    'javascript', 'typescript', 'node.js', 'nodejs', 'react', 'next.js', 'vue', 'angular',
    'python', 'go', 'golang', 'rust', 'java', 'spring', 'kafka', 'redis', 'postgresql',
    'mongodb', 'mysql', 'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform',
    'graphql', 'rest', 'api', 'sql', 'nosql', 'elastic', 'clickhouse', 'django', 'flask',
    'rails', 'php', 'laravel', 'csharp', '.net', 'c++', 'c#', 'swift', 'kotlin', 'flutter',
    'react native', 'ios', 'android', 'figma', 'product management', 'data analysis',
    'machine learning', 'tensorflow', 'pytorch', 'nlp', 'llm', 'prompt engineering',
  ];
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9.#+\s]/g, ' ')} `;
  const found = skillBank.filter((skill) => lower.includes(` ${skill.toLowerCase()} `));
  return [...new Set(found)];
}

function pickEducation(text) {
  const lines = text.split(/\n|\s{2,}/);
  const eduMarkers = /\b(B\.?Tech|M\.?Tech|B\.?E\.?|M\.?E\.?|B\.?C\.?A|M\.?C\.?A|MBA|BBA|BSc|MSc|B\.?Com|M\.?Com|B\.?A\.?|M\.?A\.?|Ph\.?D|Diploma|HSC|SSC|CBSE|ICSE|10\+2)\b/i;
  return lines
    .map((line) => line.trim())
    .filter((line) => eduMarkers.test(line))
    .slice(0, 5);
}

function pickEmployers(text) {
  const lines = text.split(/\n|\s{2,}/);
  const employers = [];
  for (const line of lines) {
    const m = line.match(/(?:at|with|from)\s+([A-Z][A-Za-z0-9\s&.,]+?)(?=\.|,|\n|$)/i);
    if (m && !/university|college|institute|school/i.test(m[1])) {
      employers.push(m[1].trim());
    }
  }
  return [...new Set(employers)].slice(0, 5);
}

/**
 * Indian CVs almost never write a phone number as ten bare digits. Real
 * attachments carry "+91 98765 43210", "98765-43210", "Mobile: (+91) 9876543210".
 * Scanning token-by-token, as this used to, sees "+91" and "98765" as separate
 * words and matches neither — so every such CV landed with noPhone set and the
 * candidate was never callable, which is the one thing this product must do.
 *
 * Patterns are ordered most-specific first so an explicit country code wins
 * over the bare ten-digit reading of the same number.
 */
const PHONE_PATTERNS = [
  /\+\s?91[\s.-]?\d{5}[\s.-]?\d{5}/g,
  /\(\+?91\)[\s.-]?\d{5}[\s.-]?\d{5}/g,
  /\b0?[6-9]\d{4}[\s.-]\d{5}\b/g,
  /\b(?:0|\+91)?[6-9]\d{9}\b/g,
  /\+\d{1,3}[\s.-]?\d{6,12}/g,
];

function pickPhone(text) {
  for (const pattern of PHONE_PATTERNS) {
    for (const match of text.match(pattern) ?? []) {
      const normalised = normalizePhoneE164(match);
      if (normalised) return normalised;
    }
  }

  // Last resort: the old token sweep, which still catches a bare number that
  // sits flush against punctuation none of the patterns above allow for.
  for (const token of text.split(/\s+/)) {
    const normalised = normalizePhoneE164(token);
    if (normalised) return normalised;
  }

  return null;
}

/**
 * Pull structured fields out of CV text that has already been decoded.
 *
 * Kept separate from decoding so the field pickers can be tested on text and
 * reused for the mail body when a message arrives with no attachment.
 */
export function parseCvText(input) {
  // Sanitised here as well as in extractText, because this is also reached
  // directly with raw email-body text, which carries the same NUL bytes.
  const text = stripUnstorable(input);
  const emails = [...text.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase());
  const email = emails[0] ?? null;

  const phone = pickPhone(text);

  return {
    name: pickName(text),
    phone,
    email,
    experience: pickExperience(text),
    skills: pickSkills(text),
    education: pickEducation(text),
    employers: pickEmployers(text),
    rawPreview: text.slice(0, 2000),
  };
}

/**
 * Synchronous entry point kept for plain-text input and for callers that
 * already hold decoded text. Passing a Buffer still works, but a Buffer of a
 * real PDF cannot be decoded synchronously — use {@link parseCvAttachment}.
 */
export function parseCv(input) {
  if (typeof input === 'string') return parseCvText(input);
  return parseCvText(extractPrintableText(input));
}

/**
 * The path an ingested attachment should take: decode by real file type, then
 * pick fields. Extraction metadata rides along so the caller can distinguish
 * "we read this CV" from "this was a scan we could not read", instead of
 * writing an empty candidate and calling it parsed.
 */
export async function parseCvAttachment(buffer, filename = '', fallbackText = '') {
  const extraction = await extractText(buffer, filename);

  // A scanned or unsupported attachment still leaves the mail body, which for
  // a lot of applications carries the name, phone and a short pitch.
  const text = extraction.ok ? extraction.text : String(fallbackText ?? '');

  return {
    parsed: {
      ...parseCvText(text),
      source: extraction.ok ? extraction.kind : 'email_body',
    },
    extraction,
  };
}

export { normalizePhoneE164 };
