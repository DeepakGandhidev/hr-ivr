import crypto from 'node:crypto';
import fs from 'node:fs';
import { SMTPServer } from 'smtp-server';
import { prisma } from '@pratibha/prisma';
import { inboundDomain } from '@pratibha/shared/mail-oauth';
import { setting } from '@pratibha/shared/settings-runtime';

import { normalise } from './imapClient.js';
import { ingestMessage, loadOpenJobs } from './poller.js';
import { forwardTokenFromRecipient, parseGmailForwardingConfirmation, unwrapForward } from './forwarding.js';

/**
 * Receive forwarded mail directly.
 *
 * A workspace that will not hand over a mailbox password gets a private address
 * (acme.k3x9q2m7wd@in.pratibha.tech) and sets a forwarding rule in Gmail,
 * Outlook or cPanel. The MX record for the inbound domain points at this
 * server, and this receiver turns each message into a candidate through the
 * same filter, router and dedupe the IMAP poller uses.
 *
 * It is receive-only: no AUTH, no relaying, and a recipient that is not a known
 * forwarding address is refused at RCPT, before any message body is accepted.
 * That makes it useless as a relay and keeps it from generating backscatter.
 */

const MAX_RECIPIENTS = 5;

function smtpError(message, responseCode) {
  const err = new Error(message);
  err.responseCode = responseCode;
  return err;
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Handle one message for one forwarding address. Throws only for failures a
 * retry could fix; the caller turns that into a 451 so the sender tries again.
 */
export async function deliverToConnection(connection, raw, logger = console) {
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  let message = await normalise(raw, `fwd-${hash}`);

  const confirmation = parseGmailForwardingConfirmation(message);
  if (confirmation) {
    await prisma.emailConnection.update({
      where: { id: connection.id },
      data: {
        forwardVerifyCode: confirmation.code,
        forwardVerifyUrl: confirmation.url,
        forwardVerifyAt: new Date(),
      },
    });
    logger.info?.({ connectionId: connection.id }, 'Gmail forwarding confirmation received');
    return 'confirmation';
  }

  // A rule that forwards (rather than redirects) sends the mail from the
  // recruiter's own address; the applicant is in the quoted header block.
  if (message.from && message.from.toLowerCase() === String(connection.address).toLowerCase()) {
    message = unwrapForward(message) ?? message;
  }

  if (connection.status === 'revoked') {
    // Paused. The original is still in the recruiter's own mailbox, so
    // accepting and dropping loses nothing — and refusing would bounce every
    // application back to them as a delivery failure.
    logger.info?.({ connectionId: connection.id }, 'Forwarding address paused; message dropped');
    return 'paused';
  }

  if (!connection.defaultJobId) {
    logger.warn?.({ connectionId: connection.id }, 'Forwarding address has no destination job; message dropped');
    await prisma.emailConnection
      .update({
        where: { id: connection.id },
        data: { status: 'error', errorDetail: 'Choose a job for this address; mail is arriving but has nowhere to go.' },
      })
      .catch(() => {});
    return 'no-job';
  }

  const openJobs = await loadOpenJobs(connection, logger);
  const outcome = await ingestMessage(connection, message, openJobs, logger);

  await prisma.emailConnection.update({
    where: { id: connection.id },
    // Real mail arriving means forwarding is confirmed; the code has done its job.
    data: { lastPollAt: new Date(), status: 'connected', errorDetail: null, forwardVerifyCode: null, forwardVerifyUrl: null },
  });

  logger.info?.({ connectionId: connection.id, from: message.from, outcome }, 'Forwarded mail handled');
  return outcome;
}

export function startInboundSmtp(logger = console, env = process.env) {
  const port = Number(env.INBOUND_SMTP_PORT);
  if (!port) {
    logger.info?.('Inbound SMTP disabled (INBOUND_SMTP_PORT not set)');
    return null;
  }

  const domain = inboundDomain(env);
  const tls = {};
  // Without a certificate smtp-server offers STARTTLS with its built-in
  // self-signed one, which forwarding senders accept (SMTP TLS between servers
  // is opportunistic). A real certificate is better and is picked up here.
  if (env.INBOUND_TLS_KEY && env.INBOUND_TLS_CERT) {
    try {
      tls.key = fs.readFileSync(env.INBOUND_TLS_KEY);
      tls.cert = fs.readFileSync(env.INBOUND_TLS_CERT);
    } catch (err) {
      logger.warn?.({ err: err.message }, 'Inbound SMTP certificate unreadable; using the built-in one');
    }
  }

  // smtp-server takes the size limit at construction (it is advertised in the
  // EHLO reply), so `email.inbound_max_mb` applies when the worker restarts.
  const maxMessageBytes = setting('email.inbound_max_mb') * 1024 * 1024;

  const server = new SMTPServer({
    name: domain,
    banner: 'Pratibha inbound mail',
    secure: false,
    ...tls,
    authOptional: true,
    disabledCommands: ['AUTH'],
    size: maxMessageBytes,
    maxClients: 50,
    socketTimeout: 60_000,
    closeTimeout: 30_000,
    logger: false,

    async onRcptTo(address, session, callback) {
      try {
        session.targets ??= [];
        if (session.targets.length >= MAX_RECIPIENTS) {
          return callback(smtpError('Too many recipients', 452));
        }

        const token = forwardTokenFromRecipient(address.address, domain);
        const connection = token
          ? await prisma.emailConnection.findUnique({ where: { forwardToken: token } })
          : null;
        if (!connection || connection.provider !== 'forward_alias') {
          return callback(smtpError('No such recipient here', 550));
        }

        session.targets.push(connection);
        return callback();
      } catch (err) {
        logger.error?.({ err: err.message }, 'Inbound SMTP recipient lookup failed');
        return callback(smtpError('Temporary failure, try again later', 451));
      }
    },

    async onData(stream, session, callback) {
      try {
        const raw = await readStream(stream);
        if (stream.sizeExceeded) {
          return callback(smtpError('Message too large', 552));
        }

        for (const connection of session.targets ?? []) {
          await deliverToConnection(connection, raw, logger);
        }
        return callback();
      } catch (err) {
        logger.error?.({ err: err.message, remote: session.remoteAddress }, 'Inbound SMTP delivery failed');
        // 451 asks the forwarding server to retry. The Message-ID dedupe makes
        // a retry of a partly handled message safe.
        return callback(smtpError('Temporary failure, try again later', 451));
      }
    },
  });

  server.on('error', (err) => logger.error?.({ err: err.message }, 'Inbound SMTP error'));
  server.listen(port, env.INBOUND_SMTP_HOST || '0.0.0.0', () => {
    logger.info?.({ port, domain }, 'Inbound SMTP listening for forwarded mail');
  });

  return {
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
