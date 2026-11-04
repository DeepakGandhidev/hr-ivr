import { NextRequest, NextResponse } from "next/server";
import { Action, ValidationError } from "@pratibha/shared";
import { buildOAuthAuthorizeUrl, isOAuthMailProvider, oauthConfigured } from "@pratibha/shared/mail-oauth";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { assertPlanAllows } from "@/lib/plan-features";
import { newOAuthState, OAUTH_COOKIE, publicAppUrl } from "@/lib/email-oauth";

export const runtime = "nodejs";

/**
 * Start "Sign in with Google / Microsoft" for a mailbox.
 *
 *   GET /api/:tenant/email-connections/oauth/gmail?jobId=…&autoRoute=true
 *
 * The browser is sent here directly (not via fetch), and leaves for the
 * provider's consent screen. The job choice travels in the sealed state, so the
 * connection is created with its destination in one step when the user returns.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; provider: string } }
) {
  const { tenant, provider } = params;
  return handleApi(async () => {
    if (!isOAuthMailProvider(provider)) throw new ValidationError("Unknown mail provider");
    if (!oauthConfigured(provider)) {
      throw new ValidationError(
        `${provider === "gmail" ? "Google" : "Microsoft"} sign-in is not set up on this server yet.`
      );
    }

    const search = request.nextUrl.searchParams;
    const jobId = search.get("jobId") ?? "";
    const autoRoute = search.get("autoRoute") === "true";
    const loginHint = search.get("loginHint") ?? undefined;

    return withTenantAuth(tenant, Action.settingsUpdate, async (ctx, tx) => {
      assertPlanAllows(ctx.tenant, "gmail_outlook_signin", "Gmail and Outlook sign in is not included in your plan.");
      if (autoRoute) {
        assertPlanAllows(ctx.tenant, "auto_route_mailboxes", "Auto routing is not included in your plan. Choose the one job this mailbox files into.");
      }
      const job = jobId ? await tx.job.findFirst({ where: { id: jobId, tenantId: ctx.tenant.id } }) : null;
      if (!job) throw new ValidationError("Choose the job these applications belong to first.");

      const { state, nonce } = newOAuthState({ tenant, provider, userId: ctx.user.id, jobId, autoRoute });
      const response = NextResponse.redirect(
        buildOAuthAuthorizeUrl(provider, { appUrl: publicAppUrl(request), state, loginHint })
      );
      response.cookies.set(OAUTH_COOKIE, nonce, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        // Lax is what lets the cookie ride along on the provider's top-level
        // redirect back to us.
        sameSite: "lax",
        path: "/api/email-oauth",
        maxAge: 600,
      });
      return response;
    });
  });
}
