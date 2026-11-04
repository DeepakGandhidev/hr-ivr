import { appUrl as publicAppUrlFor } from "@/lib/app-url";
import { randomBytes } from "crypto";
import type { NextRequest } from "next/server";
import { openSecret, safeEqual, sealSecret } from "@pratibha/shared/crypto";
import type { OAuthMailProvider } from "@pratibha/shared/mail-oauth";

/**
 * State carried through the Google/Microsoft sign-in round trip.
 *
 * It is sealed (AES-GCM, so it cannot be read or altered on the way) and bound
 * twice: to the user who started the flow, and to a nonce in a cookie only
 * their browser holds. Without the cookie check, someone could send an admin a
 * callback link carrying the attacker's own code, and the admin's click would
 * quietly connect the attacker's mailbox to the admin's workspace.
 */

export const OAUTH_COOKIE = "pratibha_email_oauth";
const STATE_TTL_MS = 10 * 60 * 1000;

export interface EmailOAuthState {
  tenant: string;
  provider: OAuthMailProvider;
  userId: string;
  jobId: string;
  autoRoute: boolean;
  nonce: string;
  exp: number;
}

export function newOAuthState(input: Omit<EmailOAuthState, "nonce" | "exp">): { state: string; nonce: string } {
  const nonce = randomBytes(18).toString("base64url");
  const payload: EmailOAuthState = { ...input, nonce, exp: Date.now() + STATE_TTL_MS };
  return { state: sealSecret(JSON.stringify(payload)), nonce };
}

/** Throws on anything tampered with, expired, or not started in this browser. */
export function openOAuthState(state: string | null, cookieNonce: string | undefined): EmailOAuthState {
  if (!state) throw new Error("The sign-in response was missing its state.");

  let payload: EmailOAuthState;
  try {
    payload = JSON.parse(openSecret(state));
  } catch {
    throw new Error("The sign-in response could not be verified.");
  }

  if (!payload.exp || payload.exp < Date.now()) {
    throw new Error("The sign-in took too long. Start again from Email settings.");
  }
  if (!cookieNonce || !safeEqual(cookieNonce, payload.nonce)) {
    throw new Error("This sign-in was started in a different browser. Start again from Email settings.");
  }
  return payload;
}

/**
 * The public origin the provider redirects back to. It has to match the
 * redirect URI registered with Google/Microsoft exactly, so the configured URL
 * wins over whatever host header reached the app behind nginx.
 */
export function publicAppUrl(request: NextRequest): string {
  return publicAppUrlFor(request.nextUrl.origin);
}
