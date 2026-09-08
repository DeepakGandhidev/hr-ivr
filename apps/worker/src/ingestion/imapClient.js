import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { openSecret } from '@pratibha/shared/crypto';

import { chooseCvAttachment } from './extractText.js';

/**
 * IMAP ingestion for mailboxes that offer no OAuth — cPanel/webmail (Dovecot),
 * Zoho, Namecheap, and most hosting-provider mail. This is the path that needs
 * no MX change and no DNS change of any kind: the mailbox already exists and
 * already receives the mail; we just read it.
 */

/** Never pull an unbounded number of messages in one tick. */
const DEFAULT_MAX_PER_POLL = 50;

/** On a first connect there is no watermark, so look back this far instead. */
const FIRST_RUN_LOOKBACK_DAYS = 7;

const CONNECT_TIMEOUT_MS = 20_000;
const SOCKET_TIMEOUT_MS = 60_000;

function requireField(connection, field) {
  const value = connection[field];
  if (!value) throw new Error(`EmailConnection ${connection.id} is missing ${field}`);
  return value;
}

function buildClient(connection) {
  const password = openSecret(requireField(connection, 'imapSecret'));

  return new ImapFlow({
    host: requireField(connection, 'imapHost'),
    port: connection.imapPort ?? 993,
    secure: connection.imapSecure !== false,
    auth: {
      // cPanel and most shared hosts want the full address as the username.
      user: connection.imapUsername || connection.address,
      pass: password,
    },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // ImapFlow's own logger is extremely verbose and would print the
    // credential exchange; the caller's logger carries what we actually need.
    logger: false,
  });
}

/** BigInt-safe: Prisma hands these back as BigInt, IMAP gives numbers. */
function toBigInt(value) {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

async function normalise(source, uid) {
  const mail = await simpleParser(source);

  const fromAddress = mail.from?.value?.[0]?.address ?? null;
  const fromName = mail.from?.value?.[0]?.name ?? null;

  const attachments = (mail.attachments ?? []).map((a) => ({
    filename: a.filename ?? 'attachment',
    contentType: a.contentType ?? null,
    contentDisposition: a.contentDisposition ?? null,
    size: a.size ?? a.content?.length ?? 0,
    content: a.content,
  }));

  // Only the headers the application filter reads. Keeping the whole header map
  // would put megabytes of Received: chains through the poller for no gain.
  const wanted = ['list-unsubscribe', 'list-id', 'precedence', 'auto-submitted', 'x-autoreply', 'x-autorespond'];
  const headers = {};
  for (const name of wanted) {
    const value = mail.headers?.get(name);
    if (value) headers[name] = typeof value === 'string' ? value : String(value.value ?? value);
  }

  return {
    uid,
    headers,
    // RFC Message-ID is globally unique, which is exactly the dedupe key the
    // Candidate.sourceEmailMsgId unique constraint wants. Falling back to the
    // UID keeps mail from servers that omit the header still idempotent.
    messageId: mail.messageId ?? `imap-uid-${uid}`,
    from: fromAddress,
    fromName,
    subject: mail.subject ?? '',
    text: mail.text ?? '',
    date: mail.date ?? null,
    attachments,
    cvAttachment: chooseCvAttachment(attachments),
  };
}

/**
 * Fetch messages that arrived since the last successful poll.
 *
 * @returns {Promise<{messages: Array, uidValidity: bigint|null, highestUid: bigint|null}>}
 */
export async function fetchNewMessages(connection, { logger = console, maxPerPoll = DEFAULT_MAX_PER_POLL } = {}) {
  const client = buildClient(connection);
  const messages = [];
  let highestUid = toBigInt(connection.lastSeenUid);
  let uidValidity = null;

  await client.connect();
  const lock = await client.getMailboxLock(connection.folder || 'INBOX');

  try {
    uidValidity = toBigInt(client.mailbox.uidValidity);
    const previousValidity = toBigInt(connection.uidValidity);

    // UIDs are only comparable within one UIDVALIDITY generation. If the server
    // renumbered the mailbox, the stored watermark refers to different messages
    // and must be abandoned rather than trusted.
    const generationChanged = previousValidity !== null && uidValidity !== null && previousValidity !== uidValidity;
    if (generationChanged) {
      logger.warn?.(
        { connectionId: connection.id, previousValidity: String(previousValidity), uidValidity: String(uidValidity) },
        'IMAP UIDVALIDITY changed; restarting from a date window'
      );
    }

    const watermark = generationChanged ? null : toBigInt(connection.lastSeenUid);

    let uids;
    if (watermark === null) {
      // First run (or a reset): a date window, so connecting a mailbox with
      // 40,000 messages does not enqueue 40,000 candidates.
      const since = new Date(Date.now() - FIRST_RUN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      uids = await client.search({ since }, { uid: true });
    } else {
      // `n:*` is an IMAP range, and the server returns the highest UID even
      // when it is below `n` — so the result still has to be filtered.
      uids = await client.search({ uid: `${watermark + 1n}:*` }, { uid: true });
      uids = uids.filter((uid) => BigInt(uid) > watermark);
    }

    uids = (uids ?? []).sort((a, b) => a - b);
    const batch = uids.slice(0, maxPerPoll);

    if (uids.length > batch.length) {
      logger.info?.(
        { connectionId: connection.id, pending: uids.length - batch.length },
        'More mail waiting than this tick will fetch; remainder follows next tick'
      );
    }

    for (const uid of batch) {
      const message = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
      if (!message?.source) continue;

      messages.push(await normalise(message.source, uid));

      const current = toBigInt(uid);
      if (current !== null && (highestUid === null || current > highestUid)) highestUid = current;
    }

    // A partial batch must not advance the watermark past what was fetched, so
    // highestUid is tracked from the messages actually read, never from `uids`.
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return { messages, uidValidity, highestUid };
}

/**
 * Verify a mailbox's credentials without ingesting anything, so the settings
 * page can tell an HR user "wrong password" at the moment they hit Save rather
 * than silently ten minutes later in a poller log.
 */
export async function verifyConnection(connection) {
  const client = buildClient(connection);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(connection.folder || 'INBOX');
    try {
      return {
        ok: true,
        folder: connection.folder || 'INBOX',
        messages: client.mailbox.exists ?? 0,
        uidValidity: String(client.mailbox.uidValidity ?? ''),
      };
    } finally {
      lock.release();
    }
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Hold an IDLE connection so new mail is picked up in seconds instead of at the
 * next poll tick. The poller remains the source of truth; this only nudges it,
 * which means a dropped IDLE socket degrades to polling rather than to silence.
 */
export function watchMailbox(connection, onNewMail, logger = console) {
  let client = null;
  let stopped = false;
  let backoffMs = 5_000;

  async function run() {
    while (!stopped) {
      try {
        client = buildClient(connection);
        await client.connect();
        await client.mailboxOpen(connection.folder || 'INBOX');
        backoffMs = 5_000;
        logger.info?.({ connectionId: connection.id, address: connection.address }, 'IMAP IDLE established');

        client.on('exists', (data) => {
          logger.info?.({ connectionId: connection.id, count: data?.count }, 'New mail signalled');
          Promise.resolve(onNewMail(connection)).catch((err) =>
            logger.error?.({ connectionId: connection.id, err: err.message }, 'IDLE handler failed')
          );
        });

        // Resolves only when the connection ends, which is what keeps the loop
        // parked here instead of spinning.
        await client.idle();
      } catch (err) {
        if (stopped) return;
        logger.error?.({ connectionId: connection.id, err: err.message, retryInMs: backoffMs }, 'IMAP IDLE dropped');
      } finally {
        await client?.logout().catch(() => {});
        client = null;
      }

      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      // Back off to a few minutes so a mailbox with a bad password does not
      // hammer the mail server (and trip its brute-force protection).
      backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
    }
  }

  run().catch((err) => logger.error?.({ err: err.message }, 'IMAP watcher exited'));

  return {
    stop: async () => {
      stopped = true;
      await client?.logout().catch(() => {});
    },
  };
}
