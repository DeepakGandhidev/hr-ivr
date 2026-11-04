/**
 * Pure helpers for mail that reaches us by forwarding. Kept apart from the SMTP
 * server so they can be tested without a socket or a database.
 */

/**
 * Gmail will not forward to an address until it is proven, and it proves it by
 * mailing that address a code and a link. That mail lands here, where nobody
 * would ever read it, so the code and link are lifted out and shown in the
 * settings page instead.
 *
 * Anyone who learns a forwarding address could send a look-alike, so the link
 * is only accepted on Google's own hosts; anything else is shown as no link.
 */
const GOOGLE_VERIFY_HOSTS = new Set(['mail-settings.google.com', 'mail.google.com', 'isolated.mail.google.com']);

export function parseGmailForwardingConfirmation(message) {
  const subject = String(message.subject ?? '');
  if (!/forwarding confirmation/i.test(subject)) return null;

  const text = String(message.text ?? '');
  const code = text.match(/confirmation code:\s*(\d{6,12})/i)?.[1] ?? subject.match(/\(#(\d{6,12})\)/)?.[1] ?? null;

  let url = null;
  for (const candidate of text.match(/https:\/\/[^\s<>"')\]]+/g) ?? []) {
    try {
      const parsed = new URL(candidate);
      if (GOOGLE_VERIFY_HOSTS.has(parsed.hostname) && /\/vf-/.test(parsed.pathname)) {
        url = parsed.toString();
        break;
      }
    } catch {
      // not a URL after all
    }
  }

  if (!code && !url) return null;
  // "Receive Mail from someone@gmail.com" names the mailbox asking to forward.
  const requestedBy = subject.match(/from\s+([^\s@]+@[^\s)]+)/i)?.[1]?.toLowerCase() ?? null;
  return { code, url, requestedBy };
}

const FORWARD_SUBJECT = /^\s*(?:(?:fwd?|fw|tr|wg|rv|enc)\s*:\s*)+/i;

// "From: Jane Doe <jane@x.com>", "From: Jane Doe [mailto:jane@x.com]",
// "From: jane@x.com" — Gmail, Outlook and Apple Mail quote the original
// sender in one of these shapes. Markdown-ish "*From:*" appears in Outlook's
// plain-text rendering of HTML forwards.
const QUOTED_FROM = [
  /^[ \t>*]*From:\*?[ \t]*"?([^"\r\n<[]*?)"?[ \t]*(?:<|\[mailto:)([^\s<>[\]]+@[^\s<>[\]]+)(?:>|\])/im,
  /^[ \t>*]*From:\*?[ \t]*([^\s<>[\]]+@[^\s<>[\]]+)[ \t]*$/im,
];

/**
 * An Outlook inbox rule set to "Forward" (rather than "Redirect"), or a person
 * forwarding a CV by hand, sends a new message from their own address with the
 * applicant quoted in the body. Read as is, every such mail looks like it came
 * from the recruiter and is skipped as their own. Recover the applicant from
 * the quoted header block instead.
 *
 * Returns null when the message is not a forward, or the original sender
 * cannot be found, so the caller keeps the message exactly as it arrived.
 */
export function unwrapForward(message) {
  const subject = String(message.subject ?? '');
  if (!FORWARD_SUBJECT.test(subject)) return null;

  const text = String(message.text ?? '');
  for (const pattern of QUOTED_FROM) {
    const match = text.match(pattern);
    if (!match) continue;

    const [name, address] = match.length === 3 ? [match[1], match[2]] : [null, match[1]];
    const from = address.replace(/^mailto:/i, '').toLowerCase();
    if (from === String(message.from ?? '').toLowerCase()) continue;

    return {
      ...message,
      from,
      fromName: name?.trim() || null,
      subject: subject.replace(FORWARD_SUBJECT, '').trim(),
    };
  }
  return null;
}

/** "acme.k3x9q2m7wd@in.pratibha.tech" -> "acme.k3x9q2m7wd", or null for another domain. */
export function forwardTokenFromRecipient(address, domain) {
  const value = String(address ?? '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return null;
  if (value.slice(at + 1) !== String(domain).toLowerCase()) return null;
  // Plus-addressing ("token+jobs@…") still reaches the token's mailbox.
  const local = value.slice(0, at).split('+')[0];
  return /^[a-z0-9-]{1,30}\.[a-z0-9]{10}$/.test(local) ? local : null;
}
