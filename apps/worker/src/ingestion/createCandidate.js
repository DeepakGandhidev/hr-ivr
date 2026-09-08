import { prisma } from '@pratibha/prisma';
import { normalizePhoneE164, parseCvText, parseCvAttachment } from './parser.js';
import { stripUnstorable } from './extractText.js';

/**
 * Build the text we fall back to when a message has no readable attachment.
 * A large share of applications to an HR inbox put the whole pitch in the body
 * and attach nothing, or attach a scan we cannot read.
 */
function bodyContext(payload) {
  return [payload.subject, payload.fromName, payload.emailBody].filter(Boolean).join('\n');
}

/**
 * Header-derived values reach the database without passing through the CV text
 * parser, so they are sanitised separately. A NUL byte in a malformed Subject
 * would fail the insert exactly as one in a PDF does.
 */
function clean(value) {
  if (value === null || value === undefined) return value;
  const out = stripUnstorable(value).trim();
  return out.length > 0 ? out : null;
}

/**
 * Create (or update) a Candidate from an ingested CV, whatever brought it in.
 *
 * Dedupe runs in two stages, because the two cases mean different things:
 *   - same Message-ID  -> we already ingested this exact mail (a re-poll,
 *     a retried webhook). Nothing new to say; return what exists.
 *   - same phone/email -> a different mail from the same person, e.g. they
 *     re-applied with an updated CV. Merge into the existing row.
 *
 * `client` exists because there are two callers with incompatible database
 * access. The poller runs outside any request and uses the module client; the
 * web app must write through the caller's tenant transaction, or row-level
 * security scopes the write to no tenant and it silently affects nothing.
 * Everything else — parsing, dedupe, the merge rules — has to stay identical
 * between the two, which is why they share this function rather than each
 * growing their own copy.
 *
 * @param {string} tenantId
 * @param {object} payload
 * @param {{client?: object}} [options]
 */
export async function upsertCandidate(tenantId, payload, options = {}) {
  const db = options.client ?? prisma;

  const {
    jobId,
    cvBuffer,
    cvFilename = '',
    cvFileRef,
    sourceEmailMsgId,
    routedBy = null,
    routingConfidence = null,
    /** How this CV arrived: 'email' (polled or forwarded), 'upload', 'manual'. */
    intake = 'email',
    /** User id when a person added this by hand; null for machine ingestion. */
    intakeBy = null,
  } = payload;

  if (!jobId) throw new Error('upsertCandidate requires a jobId');

  // Idempotency first: re-polling a mailbox must not create duplicate rows.
  if (sourceEmailMsgId) {
    const seen = await db.candidate.findUnique({ where: { sourceEmailMsgId } });
    if (seen) return { candidate: seen, created: false, deduped: true };
  }

  const fallback = bodyContext(payload);

  let parsed;
  let extraction = null;
  if (cvBuffer) {
    const result = await parseCvAttachment(cvBuffer, cvFilename, fallback);
    parsed = result.parsed;
    extraction = result.extraction;
  } else if (payload.parsed) {
    parsed = payload.parsed;
  } else {
    parsed = { ...parseCvText(fallback), source: 'email_body' };
  }

  // The From header is more reliable than anything scraped out of a CV body,
  // so it wins when both are present.
  const email = clean(payload.from ?? parsed.email);
  const phoneE164 = normalizePhoneE164(parsed.phone) ?? null;
  const name = clean(parsed.name ?? payload.fromName);

  // "Parsed" means we got something a recruiter or the interviewer can use.
  // An unreadable scan with no body text is a failure worth surfacing, not a
  // blank candidate row that looks successfully ingested.
  const parseFailed = !name && !email && !phoneE164;

  const cvParsed = {
    ...parsed,
    ...(extraction && {
      extraction: {
        kind: extraction.kind,
        ok: extraction.ok,
        pages: extraction.pages,
        needsOcr: extraction.needsOcr,
        reason: extraction.reason,
        filename: cvFilename || null,
      },
    }),
    ...(payload.subject && { emailSubject: clean(payload.subject) }),
    // Provenance travels with the parsed blob so a recruiter looking at a row
    // can tell a hand-added candidate from one the mailbox found.
    intake: { via: intake, by: intakeBy, at: new Date().toISOString() },
  };

  const existing = await db.candidate.findFirst({
    where: {
      tenantId,
      jobId,
      OR: [
        ...(phoneE164 ? [{ phoneE164 }] : []),
        ...(email ? [{ email }] : []),
      ],
    },
  });

  if (existing) {
    const candidate = await db.candidate.update({
      where: { id: existing.id },
      data: {
        cvParsed,
        parseFailed,
        noPhone: !phoneE164 && !existing.phoneE164,
        ...(cvFileRef && { cvFileRef }),
        // sourceEmailMsgId is globally unique, so it is only claimed when the
        // existing row has none — overwriting would collide with the row that
        // already owns the other id.
        ...(sourceEmailMsgId && !existing.sourceEmailMsgId && { sourceEmailMsgId }),
        ...(name && !existing.name && { name }),
        ...(phoneE164 && !existing.phoneE164 && { phoneE164 }),
        ...(email && !existing.email && { email }),
      },
    });
    return { candidate, created: false, deduped: false };
  }

  const candidate = await db.candidate.create({
    data: {
      tenantId,
      jobId,
      name,
      email,
      phoneE164,
      cvFileRef: cvFileRef ?? null,
      cvParsed,
      routedBy,
      routingConfidence,
      sourceEmailMsgId: sourceEmailMsgId ?? null,
      parseFailed,
      noPhone: !phoneE164,
    },
  });
  return { candidate, created: true, deduped: false };
}

/**
 * Email ingestion entry point. Returns the Candidate row itself, which is what
 * the poller and the forward webhook have always consumed.
 */
export async function createCandidateFromEmail(tenantId, payload) {
  const { candidate } = await upsertCandidate(tenantId, { ...payload, intake: 'email' });
  return candidate;
}
