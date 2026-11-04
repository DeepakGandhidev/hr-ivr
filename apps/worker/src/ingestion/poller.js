import { prisma } from '@pratibha/prisma';
import { planFeatureFromRow } from '@pratibha/shared';
import { OAuthRevokedError } from '@pratibha/shared/mail-oauth';
import { setting } from '@pratibha/shared/settings-runtime';

import { fetchNewMessages, watchMailbox } from './imapClient.js';
import { createCandidateFromEmail } from './createCandidate.js';
import { classifyMessage } from './applicationFilter.js';
import { matchJobFromMessage } from './jobRouter.js';

const TEN_MINUTES_MS = 10 * 60 * 1000;

// Backoff for a mailbox that will not connect.
//
// A failing connection used to be retried on the fixed interval forever, and
// three of them against one host is a login attempt every few minutes, all day.
// Shared mail hosts read that as a brute-force attempt and firewall the source
// IP - which is exactly what happened to the production server, and the retries
// are also what would re-ban it the moment the host unblocked us.
//
// Held in memory rather than on the row: this needs no migration, and a worker
// restart resetting the backoff is acceptable because a restart is rare and
// deliberate. The cap matters more than the curve - after `email.failure_rolloff`
// consecutive failures (12 by default) the mailbox is left alone entirely until
// someone fixes it and the settings panel re-tests the connection.
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

const rollOffAfter = () => setting('email.failure_rolloff');

const failures = new Map();

function backoffFor(attempts) {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
}

/** True while a previously failing mailbox is still inside its backoff window. */
function inBackoff(connectionId, now = Date.now()) {
  const record = failures.get(connectionId);
  if (!record) return false;
  if (record.attempts >= rollOffAfter()) return true;
  return now < record.nextAttemptAt;
}

function recordFailure(connectionId, now = Date.now()) {
  const attempts = (failures.get(connectionId)?.attempts ?? 0) + 1;
  const record = { attempts, nextAttemptAt: now + backoffFor(attempts) };
  failures.set(connectionId, record);
  return record;
}

/** A mailbox that answers again starts from a clean slate. */
function recordSuccess(connectionId) {
  failures.delete(connectionId);
}

export function __resetBackoff() {
  failures.clear();
}

/**
 * Providers this worker fetches from over IMAP: a password for 'imap', an
 * OAuth access token for gmail/outlook. `forward_alias` mail is pushed to the
 * inbound SMTP receiver instead, so it is never polled.
 */
export const PULL_PROVIDERS = new Set(['imap', 'gmail', 'outlook']);

function toBigInt(value) {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function ingestibleConnection(connection) {
  if (!PULL_PROVIDERS.has(connection.provider)) return false;
  // Without a destination job an ingested CV has nowhere to go. Idling is the
  // honest behaviour; inventing a job would attach candidates to the wrong role.
  const credential = connection.provider === 'imap' ? connection.imapSecret : connection.oauthRefreshSecret;
  return Boolean(connection.defaultJobId && connection.imapHost && credential);
}

/** Jobs auto-routing may choose from; empty when the mailbox files into one job. */
export async function loadOpenJobs(connection, logger = console) {
  if (!connection.autoRoute) return [];

  // A plan can take auto-routing away after a mailbox turned it on. With no
  // jobs to choose from, every message goes to the fallback job, which is
  // exactly what a one-job mailbox does.
  const tenant = await prisma.tenant.findUnique({
    where: { id: connection.tenantId },
    select: { plan: { select: { key: true, features: true } } },
  });
  if (tenant && planFeatureFromRow(tenant.plan, 'auto_route_mailboxes') === false) {
    logger.info?.({ connectionId: connection.id }, 'Plan does not include auto-routing; filing into the fallback job');
    return [];
  }

  const openJobs = await prisma.job.findMany({
    where: { tenantId: connection.tenantId, status: 'open' },
    select: { id: true, title: true, slug: true },
  });
  if (openJobs.length === 0) {
    logger.warn?.(
      { connectionId: connection.id },
      'Auto-routing is on but no jobs are open; everything will go to the fallback job'
    );
  }
  return openJobs;
}

/**
 * Turn one message into a candidate, or decide it is not an application.
 * Shared by the IMAP poller and the forwarding receiver so a mailbox behaves
 * the same however its mail reaches us.
 *
 * @returns {Promise<'ingested'|'skipped'>} Throws when the write failed and the
 *   message must be retried.
 */
export async function ingestMessage(connection, message, openJobs, logger = console) {
  // Mail from the mailbox owner is almost always a forward, a reply, or an
  // auto-response, not an application.
  if (message.from && message.from.toLowerCase() === String(connection.address).toLowerCase()) {
    return 'skipped';
  }

  // Most mail in a real inbox is not an application. Importing it anyway
  // fills the pipeline with newsletters and notifications, which a recruiter
  // then has to clear out by hand.
  const verdict = classifyMessage(message);
  if (!verdict.accept) {
    logger.debug?.(
      { connectionId: connection.id, uid: message.uid, from: message.from, reason: verdict.reason },
      'Skipping message: not an application'
    );
    return 'skipped';
  }

  // Decide the destination before writing. An unmatched application goes to
  // the fallback job rather than being dropped, so a recruiter still sees it.
  let jobId = connection.defaultJobId;
  let routedBy = 'fixed';
  let routingConfidence = null;

  if (connection.autoRoute) {
    const match = matchJobFromMessage(message, openJobs);
    if (match.jobId) {
      jobId = match.jobId;
      routedBy = 'auto';
      routingConfidence = match.confidence;
      logger.info?.(
        { connectionId: connection.id, uid: message.uid, job: match.matchedTitle, confidence: match.confidence },
        'Routed application to job'
      );
    } else {
      routedBy = 'fallback';
      logger.info?.(
        { connectionId: connection.id, uid: message.uid, subject: message.subject, runnerUp: match.runnerUp },
        'No confident job match; using the fallback job'
      );
    }
  }

  await createCandidateFromEmail(connection.tenantId, {
    jobId,
    routedBy,
    routingConfidence,
    sourceEmailMsgId: message.messageId,
    from: message.from,
    fromName: message.fromName,
    subject: message.subject,
    emailBody: message.text,
    cvBuffer: message.cvAttachment?.content ?? null,
    cvFilename: message.cvAttachment?.filename ?? '',
  });
  return 'ingested';
}

/**
 * Pull one mailbox and turn its new mail into candidates.
 *
 * The watermark advances only after the messages in the batch have been
 * written. If the process dies mid-batch the next tick refetches from the last
 * committed UID, and the Message-ID dedupe in createCandidateFromEmail absorbs
 * the overlap — at-least-once delivery with idempotent writes, rather than
 * at-most-once with silent data loss.
 */
export async function pollConnection(connection, logger = console) {
  const { messages, uidValidity } = await fetchNewMessages(connection, { logger });

  // With auto-routing on, one mailbox serves every open role. Jobs are loaded
  // once per poll rather than per message: a mailbox delivering 50 applications
  // would otherwise run 50 identical queries.
  const openJobs = await loadOpenJobs(connection, logger);

  let ingested = 0;
  let skipped = 0;

  // The watermark may only advance across a contiguous run of handled
  // messages. Advancing past one that threw would drop that application
  // permanently: nothing else ever refetches it. Holding the watermark instead
  // means a transient database blip is retried on the next tick, at the cost of
  // re-reading the handful of messages after it — which the Message-ID dedupe
  // in createCandidateFromEmail absorbs.
  let committedUid = null;
  let blocked = false;

  for (const message of messages) {
    try {
      const outcome = await ingestMessage(connection, message, openJobs, logger);
      if (outcome === 'ingested') ingested += 1;
      else skipped += 1;
      if (!blocked) committedUid = toBigInt(message.uid) ?? committedUid;
    } catch (err) {
      // Everything from here on stays unacknowledged until this one succeeds,
      // so the failure is visible in the connection's status rather than being
      // a quietly missing candidate.
      logger.error?.(
        { connectionId: connection.id, uid: message.uid, err: err.message },
        'Failed to ingest message; holding the UID watermark here'
      );
      skipped += 1;
      blocked = true;
    }
  }

  await prisma.emailConnection.update({
    where: { id: connection.id },
    data: {
      lastPollAt: new Date(),
      status: 'connected',
      errorDetail: null,
      ...(uidValidity !== null && { uidValidity }),
      ...(committedUid !== null && { lastSeenUid: committedUid }),
    },
  });

  if (blocked) {
    throw new Error(`Ingestion stopped at UID ${committedUid ?? 'start'}; ${skipped} message(s) unhandled`);
  }

  return { ingested, skipped, fetched: messages.length };
}

/** Poll every connected mailbox once. */
export async function pollAllConnections(logger = console) {
  const connections = await prisma.emailConnection.findMany({
    where: { status: { not: 'revoked' } },
  });

  const pullable = connections.filter(ingestibleConnection);
  logger.info?.(
    { total: connections.length, pullable: pullable.length },
    'Polling email connections'
  );

  const attempted = [];

  for (const connection of pullable) {
    if (inBackoff(connection.id)) continue;
    attempted.push(connection);

    try {
      const result = await pollConnection(connection, logger);
      recordSuccess(connection.id);
      logger.info?.({ connectionId: connection.id, address: connection.address, ...result }, 'Mailbox polled');
    } catch (err) {
      const { attempts, nextAttemptAt } = recordFailure(connection.id);
      const rolledOff = attempts >= rollOffAfter();

      logger.error?.({
        connectionId: connection.id,
        err: err.message,
        attempts,
        ...(rolledOff
          ? { rolledOff: true }
          : { retryInMs: nextAttemptAt - Date.now() }),
      }, rolledOff
        ? 'Poll failed; giving up on this mailbox until it is reconnected'
        : 'Poll failed');

      // A revoked sign-in has already paused the row with its own message;
      // overwriting that with 'error' would put it back in the retry loop.
      if (err instanceof OAuthRevokedError) continue;

      await prisma.emailConnection.update({
        where: { id: connection.id },
        data: { status: 'error', errorDetail: err.message.slice(0, 500) },
      }).catch(() => {});
    }
  }

  return attempted;
}

/**
 * Start the scheduler, plus an IDLE watcher per IMAP mailbox so new mail is
 * picked up in seconds. The interval poll is kept as the safety net: IDLE
 * sockets get dropped by NAT timeouts and shared-host connection limits, and a
 * missed push must cost latency, not a lost application.
 */
export function startPoller(logger = console, intervalMs = TEN_MINUTES_MS) {
  logger.info?.({ intervalMs }, 'Starting email ingestion poller');

  const watchers = new Map();

  const syncWatchers = async () => {
    const connections = await prisma.emailConnection.findMany({
      where: { provider: { in: [...PULL_PROVIDERS] }, status: { not: 'revoked' } },
    });

    const wanted = new Set();
    for (const connection of connections.filter(ingestibleConnection)) {
      wanted.add(connection.id);
      if (watchers.has(connection.id)) continue;

      watchers.set(
        connection.id,
        watchMailbox(
          connection,
          // Re-read the row on each nudge: the watcher closure holds the
          // connection as it was at start-up, but the UID watermark has moved
          // on since, and fetching from a stale one would re-ingest.
          async () => {
            const fresh = await prisma.emailConnection.findUnique({ where: { id: connection.id } });
            if (fresh && ingestibleConnection(fresh)) await pollConnection(fresh, logger);
          },
          logger
        )
      );
    }

    // Drop watchers for mailboxes that were disconnected or revoked.
    for (const [id, watcher] of watchers) {
      if (!wanted.has(id)) {
        await watcher.stop();
        watchers.delete(id);
      }
    }
  };

  const tick = () => {
    pollAllConnections(logger)
      .then(syncWatchers)
      .catch((err) => logger.error?.({ err: err.message }, 'Poller tick failed'));
  };

  const id = setInterval(tick, intervalMs);
  tick();

  return {
    stop: async () => {
      clearInterval(id);
      await Promise.all([...watchers.values()].map((w) => w.stop()));
      watchers.clear();
    },
  };
}
