import { NextRequest, NextResponse } from "next/server";
import { Action, ForbiddenError, ValidationError } from "@pratibha/shared";
import { sealSecret } from "@pratibha/shared/crypto";
import { exchangeOAuthCode, oauthImapHost, type OAuthMailProvider } from "@pratibha/shared/mail-oauth";
import { withTenantAuth } from "@/lib/authz";
import { checkImap } from "@/lib/imap";
import { OAUTH_COOKIE, openOAuthState, publicAppUrl } from "@/lib/email-oauth";
import { assertPlanAllows, assertWithinPlanLimit } from "@/lib/plan-features";

export const runtime = "nodejs";

/** The path segment is what is registered with each provider as the redirect URI. */
const PROVIDER_BY_SLUG: Record<string, OAuthMailProvider> = { google: "gmail", microsoft: "outlook" };

function imapHint(provider: OAuthMailProvider): string {
  return provider === "gmail"
    ? "Make sure IMAP is turned on in Gmail (Settings → Forwarding and POP/IMAP). On Google Workspace your admin may also need to allow IMAP."
    : "IMAP may be switched off for this mailbox. A Microsoft 365 admin can turn it on under Mail → Manage email apps.";
}

/**
 * Where Google / Microsoft send the user back after consent.
 *
 * Every outcome — success, a cancelled consent screen, a mailbox with IMAP
 * switched off — ends on the Email settings page with a message, never on a
 * raw JSON error the user cannot act on.
 */
export async function GET(request: NextRequest, { params }: { params: { provider: string } }) {
  const provider = PROVIDER_BY_SLUG[params.provider];
  const search = request.nextUrl.searchParams;
  const appUrl = publicAppUrl(request);

  let state;
  try {
    if (!provider) throw new Error("Unknown mail provider.");
    state = openOAuthState(search.get("state"), request.cookies.get(OAUTH_COOKIE)?.value);
    if (state.provider !== provider) throw new Error("The sign-in response did not match the request.");
  } catch (err) {
    // Without a trustworthy state there is no workspace to send them back to.
    const message = err instanceof Error ? err.message : "Sign-in failed.";
    return NextResponse.json({ error: "OAUTH_STATE", message }, { status: 400 });
  }

  const back = (query: Record<string, string>) => {
    const response = NextResponse.redirect(
      `${appUrl}/${state.tenant}/settings/email?${new URLSearchParams(query).toString()}`
    );
    response.cookies.set(OAUTH_COOKIE, "", { path: "/api/email-oauth", maxAge: 0 });
    return response;
  };

  const who = provider === "gmail" ? "Google" : "Microsoft";

  if (search.get("error")) {
    const denied = search.get("error") === "access_denied";
    return back({
      error: denied ? `${who} sign-in was cancelled.` : `${who} sign-in failed: ${search.get("error_description") ?? search.get("error")}`,
    });
  }

  const code = search.get("code");
  if (!code) return back({ error: `${who} did not return a sign-in code.` });

  try {
    const tokens = await exchangeOAuthCode(provider, { code, appUrl });
    if (!tokens.email) throw new ValidationError(`${who} did not say which mailbox was signed in to.`);
    if (!tokens.refreshToken) {
      throw new ValidationError(
        `${who} did not grant ongoing access. Remove Pratibha from your account's connected apps and sign in again.`
      );
    }

    const host = oauthImapHost(provider);
    const check = await checkImap({
      host,
      port: 993,
      secure: true,
      user: tokens.email,
      accessToken: tokens.accessToken,
      folder: "INBOX",
    });
    if (!check.ok) {
      throw new ValidationError(`Signed in, but could not open ${tokens.email}: ${check.error}. ${imapHint(provider)}`);
    }

    await withTenantAuth(state.tenant, Action.settingsUpdate, async (ctx, tx) => {
      // The state is sealed, but it is also bound to the person who started it:
      // a different signed-in user finishing the flow is refused.
      if (ctx.user.id !== state.userId) throw new ForbiddenError("This sign-in was started by someone else.");

      const job = await tx.job.findFirst({ where: { id: state.jobId, tenantId: ctx.tenant.id } });
      if (!job) throw new ValidationError("The chosen job no longer exists.");

      const credentials = {
        imapHost: host,
        imapPort: 993,
        imapSecure: true,
        imapUsername: tokens.email,
        oauthRefreshSecret: sealSecret(tokens.refreshToken!),
        oauthAccessSecret: sealSecret(tokens.accessToken),
        oauthExpiresAt: tokens.expiresAt,
        status: "connected" as const,
        errorDetail: null,
      };

      // Signing in again to a mailbox already connected is a reconnect (new
      // tokens after a revoke), not a second copy polling the same inbox.
      const existing = await tx.emailConnection.findFirst({
        where: { tenantId: ctx.tenant.id, provider, address: tokens.email! },
      });

      if (existing) {
        await tx.emailConnection.update({ where: { id: existing.id }, data: credentials });
      } else {
        // Checked again here, not only when sign in started: the plan or the
        // mailbox count can change while the user is on the consent screen.
        // A reconnect (above) is never refused.
        assertPlanAllows(ctx.tenant, "gmail_outlook_signin", "Gmail and Outlook sign in is not included in your plan.");
        if (state.autoRoute) {
          assertPlanAllows(ctx.tenant, "auto_route_mailboxes", "Auto routing is not included in your plan. Choose the one job this mailbox files into.");
        }
        const mailboxes = await tx.emailConnection.count({ where: { tenantId: ctx.tenant.id } });
        assertWithinPlanLimit(ctx.tenant, "mailboxes", mailboxes, 1, (max) =>
          `Your plan allows ${max} connected ${max === 1 ? "mailbox" : "mailboxes"}. Disconnect one or upgrade your plan to add another.`
        );
        await tx.emailConnection.create({
          data: {
            tenantId: ctx.tenant.id,
            provider,
            address: tokens.email!,
            defaultJobId: job.id,
            autoRoute: state.autoRoute,
            folder: "INBOX",
            ...credentials,
          },
        });
      }
    });

    return back({ connected: tokens.email });
  } catch (err) {
    return back({ error: err instanceof Error ? err.message : `${who} sign-in failed.` });
  }
}
