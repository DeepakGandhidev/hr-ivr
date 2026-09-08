import type { EmailConnection } from "@pratibha/prisma";

/**
 * Shape an EmailConnection for the API.
 *
 * Two things must never reach a client: the sealed mailbox password and the
 * OAuth token reference. Stripping them here rather than at each call site
 * means a new endpoint cannot leak them by forgetting to.
 *
 * BigInt is also removed, because the UID watermarks are BigInt columns and
 * JSON.stringify throws on those — an endpoint that returned a raw row would
 * fail at serialisation time rather than at review time.
 */
export function redactConnection(connection: EmailConnection) {
  const { imapSecret, oauthTokenRef: _oauthTokenRef, ...safe } = connection;

  return {
    ...safe,
    uidValidity: connection.uidValidity != null ? String(connection.uidValidity) : null,
    lastSeenUid: connection.lastSeenUid != null ? String(connection.lastSeenUid) : null,
    /** Lets the panel show "password saved" without ever sending the value. */
    hasCredential: Boolean(imapSecret),
    /** 'revoked' is the paused state; the ingestion poller skips those rows. */
    paused: connection.status === "revoked",
  };
}
