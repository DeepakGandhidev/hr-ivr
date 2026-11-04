import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { setting } from '@pratibha/shared/settings-runtime';

import { chooseCvAttachment } from './extractText.js';
import { imapAuthFor } from './mailAuth.js';

/**
 * IMAP ingestion: cPanel/webmail (Dovecot), Zoho, Namecheap and most
 * hosting-provider mail with a password, and Gmail/Outlook with an OAuth access
 * token (XOAUTH2). This is the path that needs no MX change and no DNS change
 * of any kind: the mailbox already exists and already receives the mail; we
 * just read it.
 */

const CONNECT_TIMEOUT_MS = 20_000;
const SOCKET_TIMEOUT_MS = 60_000;

function requireField(connection, field) {
  const value = connection[field];
  if (!value) throw new Error(`EmailConnection ${connection.id} is missing ${field}`);
  return value;
}

async function buildClient(connection, logger) {
  const host = requireField(connection, 'imapHost');
  const auth = await imapAuthFor(connection, logger);

  const client = new ImapFlow({
    host,
    port: connection.imapPort ?? 993,
    secure: connection.imapSecure !== false,
    auth,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // ImapFlow's own logger is extremely verbose and would print the
    // credential exchange; the caller's logger carries what we actually need.
    logger: false,
  });

  // ImapFlow reports a dead socket (e.g. "Socket timeout" from a host that has
  // stopped answering) as an 'error' event. With no listener Node treats that
  // as uncaught and kills the whole worker - calls, poller and the forwarding
  // receiver with it - and the restart forgets the backoff, so it happened
  // again every minute. The pending operation still rejects and is handled by
  // its caller; this only stops the event from being fatal.
  client.on('error', (err) => {
    logger?.warn?.({ connectionId: connection.id, err: err?.message }, 'IMAP connection error');
  });

  return client;
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

/** Parse a raw RFC 822 message into what the ingestion pipeline reads. */
export async function normalise(source, uid) {
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
 * Never more than `email.max_per_poll` in one tick (unless the caller passes
 * `maxPerPoll`), and on a first connect, with no watermark, mail from the last
 * `email.first_lookback_days`. Both are read per poll, so the admin panel
 * applies without a restart.
 *
 * @returns {Promise<{messages: Array, uidValidity: bigint|null, highestUid: bigint|null}>}
 */
export async function fetchNewMessages(connection, { logger = console, maxPerPoll = setting('email.max_per_poll') } = {}) {
  const client = await buildClient(connection, logger);
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
      const since = new Date(Date.now() - setting('email.first_lookback_days') * 24 * 60 * 60 * 1000);
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
export async function verifyConnection(connection, logger = console) {
  let client;
  try {
    client = await buildClient(connection, logger);
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
    await client?.logout().catch(() => {});
  }
}

/**
 * Hold an IDLE connection so new mail is picked up in seconds instead of at the
 * next poll tick. The poller remains the source of truth; this only nudges it,
 * which means a dropped IDLE socket degrades to polling rather than to silence.
 */
const IDLE_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

export function watchMailbox(connection, onNewMail, logger = console) {
  let client = null;
  let stopped = false;
  let backoffMs = 5_000;
  let attempts = 0;

  async function run() {
    while (!stopped) {
      try {
        client = await buildClient(connection, logger);
        await client.connect();
        await client.mailboxOpen(connection.folder || 'INBOX');
        backoffMs = 5_000;
        attempts = 0;
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

      // Five minutes was the cap, retried forever, and that is not a backoff -
      // it is a steady login attempt every five minutes, all day, for as long
      // as the mailbox stays broken. The production host's firewall read three
      // of those against one server as a brute-force attempt and banned the IP.
      // So the cap is hours now, and after `email.failure_rolloff` attempts (the
      // same count the poller uses) the watcher stops rather than retrying
      // something that has failed for half a day.
      attempts += 1;
      if (attempts >= setting('email.failure_rolloff')) {
        logger.warn?.(
          { connectionId: connection.id, address: connection.address, attempts },
          'IMAP IDLE giving up until the mailbox is reconnected'
        );
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, IDLE_BACKOFF_CAP_MS);
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
