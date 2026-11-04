import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildOAuthAuthorizeUrl,
  emailFromIdToken,
  exchangeOAuthCode,
  forwardAddress,
  newForwardToken,
  OAuthRevokedError,
  oauthConfigured,
  oauthRedirectUri,
  refreshOAuthToken,
} from "@pratibha/shared/mail-oauth";
import { newOAuthState, openOAuthState } from "@/lib/email-oauth";
import { redactConnection } from "@/lib/email-connection";
import { sealSecret } from "@pratibha/shared/crypto";

const env = {
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsecret",
  MICROSOFT_CLIENT_ID: "mid",
  MICROSOFT_CLIENT_SECRET: "msecret",
} as unknown as NodeJS.ProcessEnv;

function idToken(claims: Record<string, unknown>) {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function tokenResponse(status: number, body: Record<string, unknown>) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

beforeAll(() => {
  process.env.EMAIL_SECRET_KEY = "b".repeat(64);
});

describe("mail OAuth provider helpers", () => {
  it("only offers sign-in when both client id and secret are set", () => {
    expect(oauthConfigured("gmail", env)).toBe(true);
    expect(oauthConfigured("outlook", { MICROSOFT_CLIENT_ID: "x" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("asks Google for IMAP access and a refresh token", () => {
    const url = new URL(buildOAuthAuthorizeUrl("gmail", { appUrl: "https://pratibha.tech/", state: "s" }, env));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toContain("https://mail.google.com/");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pratibha.tech/api/email-oauth/google/callback");
  });

  it("asks Microsoft for IMAP and offline access on the common endpoint", () => {
    const url = new URL(buildOAuthAuthorizeUrl("outlook", { appUrl: "https://pratibha.tech", state: "s", loginHint: "a@b.com" }, env));
    expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("login_hint")).toBe("a@b.com");
    expect(oauthRedirectUri("outlook", "https://pratibha.tech")).toBe("https://pratibha.tech/api/email-oauth/microsoft/callback");
  });

  it("reads the mailbox from the id_token, including personal Microsoft accounts", () => {
    expect(emailFromIdToken(idToken({ email: "HR@Acme.com" }))).toBe("hr@acme.com");
    expect(emailFromIdToken(idToken({ preferred_username: "someone@outlook.com" }))).toBe("someone@outlook.com");
    expect(emailFromIdToken(idToken({ preferred_username: "not-an-email" }))).toBeNull();
    expect(emailFromIdToken("garbage")).toBeNull();
  });

  it("exchanges a code for tokens and the signed-in address", async () => {
    const fetchImpl = tokenResponse(200, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3599,
      id_token: idToken({ email: "hr@gmail.com" }),
    });
    const tokens = await exchangeOAuthCode("gmail", { code: "c", appUrl: "https://pratibha.tech" }, env, fetchImpl);
    expect(tokens).toMatchObject({ accessToken: "at", refreshToken: "rt", email: "hr@gmail.com" });
    const body = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("client_secret=gsecret");
  });

  it("treats invalid_grant as a revoked sign-in, and other failures as retryable", async () => {
    await expect(
      refreshOAuthToken("outlook", "rt", env, tokenResponse(400, { error: "invalid_grant", error_description: "AADSTS70000: expired" }))
    ).rejects.toBeInstanceOf(OAuthRevokedError);

    const transient = refreshOAuthToken("gmail", "rt", env, tokenResponse(503, { error: "backendError" }));
    await expect(transient).rejects.toThrow(/backendError/);
    await expect(transient).rejects.not.toBeInstanceOf(OAuthRevokedError);
  });

  it("makes private, recognisable forwarding addresses", () => {
    const token = newForwardToken("acme-hiring", () => new Uint8Array(16).fill(7));
    expect(token).toMatch(/^acme-hiring\.[a-z0-9]{10}$/);
    expect(forwardAddress(token, { INBOUND_EMAIL_DOMAIN: "In.Example.com" } as unknown as NodeJS.ProcessEnv)).toBe(`${token}@in.example.com`);
  });
});

describe("sign-in state", () => {
  const input = { tenant: "acme", provider: "gmail" as const, userId: "u1", jobId: "j1", autoRoute: true };

  it("round-trips for the browser that started it", () => {
    const { state, nonce } = newOAuthState(input);
    expect(openOAuthState(state, nonce)).toMatchObject(input);
  });

  it("refuses a different browser, a tampered state, and a stale one", () => {
    const { state, nonce } = newOAuthState(input);
    expect(() => openOAuthState(state, undefined)).toThrow(/different browser/);
    expect(() => openOAuthState(state, `${nonce}x`)).toThrow(/different browser/);
    expect(() => openOAuthState(`${state.slice(0, -4)}AAAA`, nonce)).toThrow(/could not be verified/);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    try {
      expect(() => openOAuthState(state, nonce)).toThrow(/took too long/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("redactConnection", () => {
  it("never returns OAuth tokens, and shows the forwarding address", () => {
    const row = {
      id: "c1",
      provider: "forward_alias",
      address: "hr@acme.com",
      imapSecret: null,
      oauthTokenRef: null,
      oauthRefreshSecret: sealSecret("rt"),
      oauthAccessSecret: sealSecret("at"),
      forwardToken: "acme.k3x9q2m7wd",
      uidValidity: null,
      lastSeenUid: null,
      status: "connected",
    };
    const out = redactConnection(row as never) as Record<string, unknown>;
    expect(out).not.toHaveProperty("oauthRefreshSecret");
    expect(out).not.toHaveProperty("oauthAccessSecret");
    expect(out.hasCredential).toBe(true);
    expect(out.forwardAddress).toBe("acme.k3x9q2m7wd@in.pratibha.tech");
  });
});
