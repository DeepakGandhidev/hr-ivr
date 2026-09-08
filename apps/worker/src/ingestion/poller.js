import { prisma } from '@pratibha/prisma';

import { fetchNewMessages, watchMailbox } from './imapClient.js';
import { createCandidateFromEmail } from './createCandidate.js';
import { classifyMessage } from './applicationFilter.js';
import { matchJobFromMessage } from './jobRouter.js';

const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Providers this worker can actually fetch from. `forward_alias` mail arrives
 * by webhook rather than being pulled, and gmail/outlook still need their OAuth
 * token exchange, so neither is polled here.
 */
const PULL_PROVIDERS = new Set(['imap']);

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
  return Boolean(connection.defaultJobId && connection.imapHost && connection.imapSecret);
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
  const openJobs = connection.autoRoute
    ? await prisma.job.findMany({
        where: { tenantId: connection.tenantId, status: 'open' },
        select: { id: true, title: true, slug: true },
      })
    : [];

  if (connection.autoRoute && openJobs.length === 0) {
    logger.warn?.(
      { connectionId: connection.id },
      'Auto-routing is on but no jobs are open; everything will go to the fallback job'
    );
  }

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
    // Mail from the mailbox owner is almost always a forward, a reply, or an
    // auto-response, not an application.
    if (message.from && message.from.toLowerCase() === String(connection.address).toLowerCase()) {
      skipped += 1;
      if (!blocked) committedUid = toBigInt(message.uid) ?? committedUid;
      continue;
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
      skipped += 1;
      if (!blocked) committedUid = toBigInt(message.uid) ?? committedUid;
      continue;
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

    try {
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
      ingested += 1;
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

  for (const connection of pullable) {
    try {
      const result = await pollConnection(connection, logger);
      logger.info?.({ connectionId: connection.id, address: connection.address, ...result }, 'Mailbox polled');
    } catch (err) {
      logger.error?.({ connectionId: connection.id, err: err.message }, 'Poll failed');
      await prisma.emailConnection.update({
        where: { id: connection.id },
        data: { status: 'error', errorDetail: err.message.slice(0, 500) },
      }).catch(() => {});
    }
  }

  return pullable;
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
      where: { provider: 'imap', status: { not: 'revoked' } },
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
