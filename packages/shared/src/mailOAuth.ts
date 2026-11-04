/**
 * Gmail and Outlook sign-in for mailbox ingestion.
 *
 * Both providers are read over IMAP with XOAUTH2 rather than through the Gmail
 * API or Microsoft Graph. That keeps one ingestion path for every pulled
 * mailbox: the poller, the IDLE watcher, the UID watermark and the backoff are
 * the ones already proven against cPanel hosts. The only thing OAuth changes is
 * what is handed to the IMAP login — an access token instead of a password.
 *
 * Shared by the web app (the sign-in redirect and code exchange) and the worker
 * (refreshing the access token before each login), so the provider details live
 * in exactly one place.
 */

export type OAuthMailProvider = 'gmail' | 'outlook';

interface ProviderSpec {
  authorizeUrl: string;
  tokenUrl: string;
  /** IMAP access needs these exact scopes; narrower ones do not grant IMAP. */
  scopes: string[];
  imapHost: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra authorize parameters each provider needs for a refresh token. */
  authorizeExtras: Record<string, string>;
}

const PROVIDERS: Record<OAuthMailProvider, ProviderSpec> = {
  gmail: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // IMAP is only reachable with the full mail scope; gmail.readonly is an
    // API-only scope and the IMAP server rejects it.
    scopes: ['openid', 'email', 'https://mail.google.com/'],
    imapHost: 'imap.gmail.com',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    // Google only returns a refresh token on a consent screen, and only with
    // offline access; without both a reconnect silently gets no refresh token.
    authorizeExtras: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  outlook: {
    // "common" serves both work/school (Microsoft 365) and personal
    // (outlook.com, hotmail.com, live.com) accounts.
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'email', 'offline_access', 'https://outlook.office.com/IMAP.AccessAsUser.All'],
    imapHost: 'outlook.office365.com',
    clientIdEnv: 'MICROSOFT_CLIENT_ID',
    clientSecretEnv: 'MICROSOFT_CLIENT_SECRET',
    authorizeExtras: { prompt: 'select_account' },
  },
};

export function isOAuthMailProvider(value: unknown): value is OAuthMailProvider {
  return value === 'gmail' || value === 'outlook';
}

export function oauthImapHost(provider: OAuthMailProvider): string {
  return PROVIDERS[provider].imapHost;
}

function credentials(provider: OAuthMailProvider, env: NodeJS.ProcessEnv = process.env) {
  const spec = PROVIDERS[provider];
  const clientId = env[spec.clientIdEnv];
  const clientSecret = env[spec.clientSecretEnv];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** False until the provider's client id and secret are in the environment. */
export function oauthConfigured(provider: OAuthMailProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  return credentials(provider, env) !== null;
}

/**
 * The callback URL registered with the provider. One fixed path per provider,
 * because Google and Microsoft both require an exact match.
 */
export function oauthRedirectUri(provider: OAuthMailProvider, appUrl: string): string {
  const slug = provider === 'gmail' ? 'google' : 'microsoft';
  return `${appUrl.replace(/\/+$/, '')}/api/email-oauth/${slug}/callback`;
}

export function buildOAuthAuthorizeUrl(
  provider: OAuthMailProvider,
  opts: { appUrl: string; state: string; loginHint?: string },
  env: NodeJS.ProcessEnv = process.env
): string {
  const creds = credentials(provider, env);
  if (!creds) throw new Error(`${provider} sign-in is not configured`);
  const spec = PROVIDERS[provider];

  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: oauthRedirectUri(provider, opts.appUrl),
    response_type: 'code',
    scope: spec.scopes.join(' '),
    state: opts.state,
    ...spec.authorizeExtras,
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  });
  return `${spec.authorizeUrl}?${params.toString()}`;
}

export interface OAuthTokens {
  accessToken: string;
  /** Absent on some refreshes: keep the one already stored. */
  refreshToken: string | null;
  expiresAt: Date;
  /** The signed-in mailbox, read from the id_token. Only on the code exchange. */
  email: string | null;
}

/**
 * A refresh the provider has refused for good (revoked access, changed
 * password, expired grant). Retrying cannot fix it; the user must sign in again.
 */
export class OAuthRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthRevokedError';
  }
}

/**
 * The id_token comes straight from the provider's token endpoint over TLS, in
 * exchange for a code and our client secret, so its claims are trusted without
 * a signature check (OpenID Connect Core §3.1.3.7).
 */
export function emailFromIdToken(idToken: string | undefined | null): string | null {
  if (!idToken) return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    // Personal Microsoft accounts often omit `email` and carry the address in
    // preferred_username instead.
    const email = claims.email ?? claims.preferred_username ?? null;
    return typeof email === 'string' && email.includes('@') ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function tokenRequest(
  provider: OAuthMailProvider,
  body: Record<string, string>,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<OAuthTokens> {
  const creds = credentials(provider, env);
  if (!creds) throw new Error(`${provider} sign-in is not configured`);

  const res = await fetchImpl(PROVIDERS[provider].tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...body }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== 'string') {
    const code = typeof data.error === 'string' ? data.error : `http_${res.status}`;
    const detail = typeof data.error_description === 'string' ? data.error_description.split('\n')[0] : '';
    const message = `${provider} token request failed: ${code}${detail ? ` (${detail})` : ''}`;
    // invalid_grant is the one answer that means "this grant is dead".
    if (code === 'invalid_grant') throw new OAuthRevokedError(message);
    throw new Error(message);
  }

  const expiresIn = Number(data.expires_in) || 3600;
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    email: emailFromIdToken(typeof data.id_token === 'string' ? data.id_token : null),
  };
}

export function exchangeOAuthCode(
  provider: OAuthMailProvider,
  opts: { code: string; appUrl: string },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthTokens> {
  return tokenRequest(
    provider,
    { grant_type: 'authorization_code', code: opts.code, redirect_uri: oauthRedirectUri(provider, opts.appUrl) },
    env,
    fetchImpl
  );
}

export function refreshOAuthToken(
  provider: OAuthMailProvider,
  refreshToken: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthTokens> {
  return tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: refreshToken }, env, fetchImpl);
}

// --- Forwarding addresses ----------------------------------------------------

/** Domain whose MX points at the worker's inbound SMTP receiver. */
export function inboundDomain(env: NodeJS.ProcessEnv = process.env): string {
  return (env.INBOUND_EMAIL_DOMAIN || 'in.pratibha.tech').toLowerCase();
}

export function forwardAddress(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${token}@${inboundDomain(env)}`;
}

/**
 * The tenant slug keeps the address recognisable in a mail rule; the random
 * part is what makes it private. 10 base-36 characters is ~51 bits.
 */
export function newForwardToken(tenantSlug: string, random: () => Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = random();
  let suffix = '';
  for (let i = 0; i < 10; i += 1) suffix += alphabet[bytes[i]! % alphabet.length];
  const prefix = tenantSlug.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'jobs';
  return `${prefix}.${suffix}`;
}
