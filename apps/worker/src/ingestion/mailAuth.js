import { prisma } from '@pratibha/prisma';
import { openSecret, sealSecret } from '@pratibha/shared/crypto';
import { isOAuthMailProvider, refreshOAuthToken, OAuthRevokedError } from '@pratibha/shared/mail-oauth';

/**
 * What to hand ImapFlow's `auth` option for a connection: the sealed password
 * for a plain IMAP mailbox, or a live access token for a Gmail/Outlook sign-in.
 */

/** Refresh this long before expiry, so a token never dies mid-fetch. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * The poller and the IDLE watcher can both need a token at the same moment.
 * One refresh serves both; Microsoft rotates refresh tokens, and two racing
 * refreshes would each store a different one.
 */
const inflight = new Map();

async function refreshFor(connection, logger) {
  // The caller's row can be hours old (the IDLE watcher holds the one it
  // started with), so the current tokens are read fresh.
  const row = await prisma.emailConnection.findUnique({ where: { id: connection.id } });
  if (!row?.oauthRefreshSecret) {
    throw new Error('This mailbox has no saved sign-in; connect it again from Email settings');
  }

  if (row.oauthAccessSecret && row.oauthExpiresAt && row.oauthExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
    return openSecret(row.oauthAccessSecret);
  }

  let tokens;
  try {
    tokens = await refreshOAuthToken(row.provider, openSecret(row.oauthRefreshSecret));
  } catch (err) {
    if (err instanceof OAuthRevokedError) {
      const who = row.provider === 'gmail' ? 'Google' : 'Microsoft';
      // Paused rather than left in 'error': retrying a dead grant only fills
      // the log, and the panel shows the reason next to a Reconnect button.
      await prisma.emailConnection
        .update({
          where: { id: row.id },
          data: { status: 'revoked', errorDetail: `${who} access was withdrawn. Sign in again to reconnect.` },
        })
        .catch(() => {});
      logger.warn?.({ connectionId: row.id, err: err.message }, 'OAuth grant revoked; mailbox paused');
    }
    throw err;
  }

  await prisma.emailConnection.update({
    where: { id: row.id },
    data: {
      oauthAccessSecret: sealSecret(tokens.accessToken),
      oauthExpiresAt: tokens.expiresAt,
      ...(tokens.refreshToken && { oauthRefreshSecret: sealSecret(tokens.refreshToken) }),
    },
  });

  return tokens.accessToken;
}

export async function accessTokenFor(connection, logger = console) {
  const pending = inflight.get(connection.id);
  if (pending) return pending;

  const promise = refreshFor(connection, logger).finally(() => inflight.delete(connection.id));
  inflight.set(connection.id, promise);
  return promise;
}

export async function imapAuthFor(connection, logger = console) {
  const user = connection.imapUsername || connection.address;

  if (isOAuthMailProvider(connection.provider)) {
    return { user, accessToken: await accessTokenFor(connection, logger) };
  }

  if (!connection.imapSecret) throw new Error(`EmailConnection ${connection.id} is missing imapSecret`);
  // cPanel and most shared hosts want the full address as the username.
  return { user, pass: openSecret(connection.imapSecret) };
}
