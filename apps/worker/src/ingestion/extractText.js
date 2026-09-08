import { PDFParse } from 'pdf-parse';

/**
 * Turn a CV attachment into plain text.
 *
 * The previous implementation ran `buffer.toString('binary')` over every
 * attachment and swept for printable characters. That works for .txt and
 * nothing else: a PDF keeps its text inside Flate-compressed content streams,
 * so the sweep returned compression noise, and the field pickers downstream
 * then "found" a name and skills in that noise. A CV that silently parses into
 * garbage is worse than one that fails, because it reaches the interviewer's
 * system prompt as fact.
 *
 * So each format is now either decoded properly or reported as unsupported.
 */

/** Refuse to buffer an unreasonable attachment into memory. */
const MAX_BYTES = 15 * 1024 * 1024;

/** A malformed PDF can keep pdf.js busy; the poller must not block on one. */
const PARSE_TIMEOUT_MS = 30_000;

const KIND = {
  pdf: 'pdf',
  text: 'text',
  unsupported: 'unsupported',
  empty: 'empty',
};

function sniff(buffer, filename) {
  const name = String(filename ?? '').toLowerCase();

  // Magic bytes first: attachment filenames are attacker- and
  // recruiter-supplied, and "resume.pdf" is regularly a Word file.
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return KIND.pdf;

  // PK zip header — .docx/.odt are zip containers. Extracting them needs a
  // zip reader we deliberately did not add, so say so rather than guess.
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return KIND.unsupported;

  // Legacy .doc (OLE compound file).
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') return KIND.unsupported;

  if (/\.(txt|md|csv|rtf)$/.test(name)) return KIND.text;

  // No signature and no known extension: treat it as text only if it decodes
  // as mostly-printable UTF-8, so binary formats fall through to unsupported.
  const sample = buffer.subarray(0, 4096).toString('utf8');
  const printable = sample.replace(/[^\P{C}\n\r\t]/gu, '').length;
  if (sample.length > 0 && printable / sample.length > 0.9) return KIND.text;

  return KIND.unsupported;
}

async function withTimeout(promise, ms, onTimeoutMessage) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(onTimeoutMessage)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Remove characters Postgres refuses to store.
 *
 * PDFs and mail bodies carry NUL bytes — from padded font tables, from binary
 * parts decoded as text, from Word exports. Postgres rejects \u0000 in text and
 * jsonb outright (error 22P05), so a single one anywhere in an extracted CV
 * fails the whole `candidate.create()`. Because the poller holds its UID
 * watermark on failure, that one message stalls every message behind it: one
 * malformed PDF quietly stops the entire mailbox.
 *
 * Lone surrogates go too — they survive JSON.stringify but are not valid UTF-8,
 * and Postgres rejects them the same way.
 */
export function stripUnstorable(text) {
  return String(text ?? '')
    // NUL and the other C0 controls that carry no meaning in extracted text.
    // Matching control characters is the entire purpose here, so no-control-regex
    // is suppressed deliberately rather than worked around.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // Unpaired surrogate halves.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function tidy(text) {
  return stripUnstorable(text)
    .replace(/\r\n?/g, '\n')
    // pdf.js emits soft hyphens and zero-width joiners that break word matching.
    .replace(/\u00AD|\u200B|\u200C|\u200D|\uFEFF/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    // `pageJoiner` overrides the default "-- 1 of 3 --" banner, which would
    // otherwise land in the text the skill and education pickers read.
    const result = await withTimeout(
      parser.getText({ pageJoiner: '\n' }),
      PARSE_TIMEOUT_MS,
      'PDF text extraction timed out'
    );
    return { text: tidy(result.text), pages: result.total ?? result.pages?.length ?? null };
  } finally {
    // pdf.js holds a worker per document; not releasing it leaks across polls.
    await parser.destroy?.().catch(() => {});
  }
}

/**
 * @returns {Promise<{ok: boolean, kind: string, text: string, pages: number|null,
 *   needsOcr: boolean, reason: string|null}>}
 */
export async function extractText(buffer, filename = '') {
  const base = { text: '', pages: null, needsOcr: false, reason: null };

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ...base, ok: false, kind: KIND.empty, reason: 'Attachment was empty' };
  }
  if (buffer.length > MAX_BYTES) {
    return { ...base, ok: false, kind: KIND.unsupported, reason: `Attachment exceeds ${MAX_BYTES} bytes` };
  }

  const kind = sniff(buffer, filename);

  if (kind === KIND.text) {
    const text = tidy(buffer.toString('utf8'));
    return { ...base, ok: text.length > 0, kind, text, reason: text ? null : 'No readable text' };
  }

  if (kind === KIND.pdf) {
    try {
      const { text, pages } = await extractPdf(buffer);
      if (text.length === 0) {
        // A PDF with pages but no text layer is a scan or a photo. It is not a
        // parse failure, it is a different job (OCR) we do not do yet — the
        // distinction decides whether a human should re-upload or re-type.
        return { ...base, ok: false, kind, pages, needsOcr: true, reason: 'PDF has no text layer (likely scanned)' };
      }
      return { ...base, ok: true, kind, text, pages };
    } catch (err) {
      return { ...base, ok: false, kind, reason: `PDF parse failed: ${err.message}` };
    }
  }

  return {
    ...base,
    ok: false,
    kind: KIND.unsupported,
    reason: `Unsupported attachment type${filename ? ` (${filename})` : ''}`,
  };
}

/** Pick the attachment most likely to be the CV from a mail message. */
export function chooseCvAttachment(attachments = []) {
  const candidates = attachments.filter((a) => a && a.content && a.content.length > 0);
  if (candidates.length === 0) return null;

  const score = (a) => {
    const name = String(a.filename ?? '').toLowerCase();
    let s = 0;
    if (/\.pdf$/.test(name)) s += 10;
    if (/\.docx?$/.test(name)) s += 6;
    if (/(resume|cv|curriculum|profile|bio-?data)/.test(name)) s += 8;
    // Signature images and inline logos are never the CV.
    if (/\.(png|jpe?g|gif|bmp|svg|webp)$/.test(name)) s -= 20;
    if (a.contentDisposition === 'inline') s -= 5;
    return s;
  };

  const best = candidates.map((a) => ({ a, s: score(a) })).sort((x, y) => y.s - x.s)[0];

  // A positive score means the file actually looks like a document a CV would
  // arrive in. Returning the best of a bad set was how a Microsoft Teams
  // notification — whose parts are UUID-named blobs scoring zero — got treated
  // as someone's resume and became a candidate called "gdivyank sent a
  // message". No plausible document means no CV, not "the least implausible".
  return best.s > 0 ? best.a : null;
}

/** True when the filename itself claims to be a CV, not merely a document. */
export function isCvNamed(attachment) {
  return /(resume|cv|curriculum|bio-?data)/i.test(String(attachment?.filename ?? ''));
}

export { KIND as ATTACHMENT_KIND };
