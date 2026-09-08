import { isCvNamed } from './extractText.js';

/**
 * Decide whether a message is a job application at all.
 *
 * A real inbox is mostly not applications. Pointing ingestion at one without
 * this gate turns every newsletter into a candidate: a Figma announcement
 * becomes a person named "Design with community in mind" with the skills
 * "go, figma", and a recruiter opens the pipeline to find it full of Cloudflare
 * and Microsoft Teams notifications.
 *
 * Two rules, in order:
 *   1. Bulk and automated senders are out, attachment or not. Invoices,
 *      statements and marketing decks are PDFs too, so "has a document" is not
 *      evidence of an application.
 *   2. From a human sender, a document attachment is enough on its own —
 *      discarding a real application costs far more than keeping a stray file.
 *
 * A file that names itself a resume overrides rule 1, which covers the
 * applicant whose agency or job board mails on their behalf.
 */

/** Sender local-parts that never send job applications. */
const ROBOT_SENDERS =
  /^(no-?reply|do-?not-?reply|noreply|announcements?|notifications?|updates?|news|newsletter|mailer-daemon|postmaster|bounce|alerts?|billing|invoices?|receipts?|security|team|hello|info|marketing|em|list)([-+.].*)?$/i;

/** Domains that are infrastructure rather than a person's mailbox. */
const ROBOT_DOMAINS = /(^|\.)(mail|email|em\d*|mailer|notifications?|updates?|announce)\./i;

/** Words that indicate someone is applying, in English and common Hinglish. */
const APPLICATION_TERMS =
  /\b(appl(y|ying|ication|ied)|resume|resumé|cv|curriculum vitae|candidature|position|vacancy|opening|job|role|interview|hiring|recruit|fresher|experienced|notice period|current ctc|expected ctc|naukri|internship|intern)\b/i;

/** Headers that mark a message as bulk, automated, or a mailing list. */
function isBulk(headers = {}) {
  const get = (name) => String(headers[name] ?? '').toLowerCase();

  // Any sender doing bulk mail correctly sets one of these. Applications
  // written by a person in their mail client set none of them.
  if (headers['list-unsubscribe']) return 'has List-Unsubscribe (bulk mail)';
  if (headers['list-id']) return 'has List-Id (mailing list)';

  const precedence = get('precedence');
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') {
    return `Precedence: ${precedence}`;
  }

  const auto = get('auto-submitted');
  if (auto && auto !== 'no') return `Auto-Submitted: ${auto}`;

  // Out-of-office and vacation responders.
  if (get('x-autoreply') || get('x-autorespond')) return 'auto-responder';

  return null;
}

function isRobotSender(from) {
  const address = String(from ?? '').toLowerCase().trim();
  if (!address.includes('@')) return null;

  const [local, domain] = address.split('@');

  // "noreply" is regularly buried mid-address rather than sitting at the front
  // — Google Drive shares arrive from drive-shares-dm-noreply@google.com, which
  // the anchored pattern below does not match.
  if (/(^|[-_.+])(no-?reply|do-?not-?reply)([-_.+]|$)/.test(local)) {
    return `sender "${local}@" is an automated address`;
  }
  if (ROBOT_SENDERS.test(local)) return `sender "${local}@" is an automated address`;
  if (ROBOT_DOMAINS.test(domain)) return `sender domain "${domain}" is a bulk-mail domain`;
  return null;
}

/**
 * @param {object} message  normalised message from imapClient
 * @param {object} [options]
 * @param {boolean} [options.requireCv]  admit only mail carrying a readable CV
 * @returns {{accept: boolean, reason: string, signal: string}}
 */
export function classifyMessage(message, options = {}) {
  const { requireCv = false } = options;

  const headers = message.headers ?? {};
  const from = message.from ?? '';
  const subject = message.subject ?? '';
  const body = message.text ?? '';
  const haystack = `${subject}\n${body}`;

  const hasCv = Boolean(message.cvAttachment);

  // Bulk and automated senders are rejected even when they carry a document.
  // Treating any attachment as proof of an application was how an Anthropic
  // invoice became a candidate named "Page 1 of 1": invoices, statements and
  // marketing decks are all PDFs. Only a file that names itself a resume
  // overrides this, which covers an applicant whose agency mails on their
  // behalf from a shared address.
  const namedCv = hasCv && isCvNamed(message.cvAttachment);

  const bulk = isBulk(headers);
  if (bulk && !namedCv) return { accept: false, reason: bulk, signal: 'bulk' };

  const robot = isRobotSender(from);
  if (robot && !namedCv) return { accept: false, reason: robot, signal: 'robot' };

  // From a human sender, a document attachment is the strongest signal there
  // is — losing a real application costs far more than keeping a stray file.
  if (hasCv) {
    return { accept: true, reason: 'has a CV attachment', signal: 'attachment' };
  }

  if (requireCv) {
    return { accept: false, reason: 'no CV attached (attachment required)', signal: 'no-attachment' };
  }

  // No attachment and not obviously bulk: require the message to actually talk
  // about applying, so ordinary correspondence does not become a candidate.
  if (!APPLICATION_TERMS.test(haystack)) {
    return { accept: false, reason: 'no application wording and no CV attached', signal: 'off-topic' };
  }

  return { accept: true, reason: 'application wording in the message', signal: 'wording' };
}
