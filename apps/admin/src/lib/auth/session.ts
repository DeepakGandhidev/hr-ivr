import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { AdminSession, AdminUser, AdminSessionStage } from "@pratibha/prisma";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { AdminApiError, forbidden } from "@/lib/http";
import { can, refusalReason, type Permission } from "@/lib/auth/roles";

/**
 * Admin sessions: a random token in a cookie, its hash in admin_sessions,
 * checked against the database on every request.
 *
 * Nothing here knows the portal exists. The cookie has its own name and is
 * host-only on the admin hostname (the __Host- prefix makes the browser refuse
 * a Domain attribute), so a portal cookie is never sent here and this one is
 * never sent to the portal; and a portal session is not a row in this table,
 * so there is nothing it could present that would match.
 */
const SECURE = process.env.NODE_ENV === "production";
export const SESSION_COOKIE = SECURE ? "__Host-pratibha_admin" : "pratibha_admin";

/** How often an active session's last-seen time is written back. */
const TOUCH_INTERVAL_MS = 60_000;

/** How long a correct password waits for its two step code. */
const AWAITING_CODE_MS = 10 * 60_000;

export type SignedInAdmin = { admin: AdminUser; session: AdminSession };

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function panelEnabled(): boolean {
  return process.env.ADMIN_PANEL_ENABLED === "true";
}

function requestMeta() {
  const h = headers();
  return {
    ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || null,
    userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
  };
}

export async function createSession(adminUserId: string, stage: AdminSessionStage): Promise<AdminSession> {
  const settings = await getSettings();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + Number(settings["admin.session_max_hours"]) * 3_600_000);
  const meta = requestMeta();

  const session = await db.adminSession.create({
    data: {
      adminUserId,
      tokenHash: hashToken(token),
      stage,
      codeVerifiedAt: null,
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
  });

  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });

  return session;
}

export function clearSessionCookie() {
  cookies().set(SESSION_COOKIE, "", { httpOnly: true, secure: SECURE, sameSite: "strict", path: "/", maxAge: 0 });
}

export type SessionLookup =
  | { state: "none" }
  | { state: "ended" }
  | { state: "awaiting_code"; admin: AdminUser; session: AdminSession }
  | { state: "active"; admin: AdminUser; session: AdminSession };

/**
 * Resolve the cookie to a session, enforcing every way one can end: revoked,
 * past its absolute expiry, idle too long, or belonging to an admin who has
 * been deactivated since. A deactivated admin's very next request lands here,
 * which is how "dies within a minute" is met with room to spare.
 */
export async function lookupSession(): Promise<SessionLookup> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { state: "none" };

  const session = await db.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { admin: true },
  });
  if (!session) return { state: "ended" };

  const now = Date.now();
  const settings = await getSettings();
  const idleMs = Number(settings["admin.session_idle_minutes"]) * 60_000;

  const dead =
    session.revokedAt !== null ||
    session.expiresAt.getTime() <= now ||
    session.lastSeenAt.getTime() + idleMs <= now ||
    session.admin.deactivatedAt !== null ||
    // A password with no code after it is worth ten minutes, not a day.
    (session.stage === "awaiting_code" && now - session.createdAt.getTime() > AWAITING_CODE_MS);

  if (dead) {
    if (!session.revokedAt) {
      await db.adminSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } }).catch(() => {});
    }
    return { state: "ended" };
  }

  if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.$transaction([
      db.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }),
      db.adminUser.update({ where: { id: session.adminUserId }, data: { lastActiveAt: new Date() } }),
    ]);
  }

  const { admin, ...rest } = session;
  return { state: session.stage, admin, session: rest as AdminSession };
}

/** For pages: an active admin, or a redirect to sign in that says why. */
export async function requireAdminPage(): Promise<SignedInAdmin> {
  const found = await lookupSession();
  if (found.state === "active") return { admin: found.admin, session: found.session };
  if (found.state === "awaiting_code") redirect("/sign-in/code");
  redirect(found.state === "ended" ? "/sign-in?expired=1" : "/sign-in");
}

/** For API routes: an active admin, or a 401 the client turns into sign in. */
export async function requireAdmin(permission: Permission = "view"): Promise<SignedInAdmin> {
  if (!panelEnabled()) throw new AdminApiError(404, "NOT_FOUND", "Not found");
  const found = await lookupSession();
  if (found.state !== "active") {
    throw new AdminApiError(401, "SESSION_ENDED", "Your session has ended. Sign in again.");
  }
  if (!can(found.admin.role, permission)) {
    await recordRefusal(found.admin, permission);
    throw forbidden(refusalReason(found.admin.role, permission));
  }
  return { admin: found.admin, session: found.session };
}

/**
 * A refusal is a receipt too. Written outside any transaction so it survives
 * the 403 it accompanies; a failure to write it never masks the refusal.
 */
async function recordRefusal(admin: AdminUser, permission: Permission) {
  try {
    await db.activityLog.create({
      data: {
        actorType: "admin",
        actorId: admin.id,
        actorName: admin.name,
        action: "admin.refused",
        summary: `${admin.name} was refused: ${permission} is not allowed for ${admin.role}`,
        after: { permission, role: admin.role },
      },
    });
  } catch (error) {
    console.error("[admin] could not record refusal", error);
  }
}

/** Whether the session entered a two step code recently enough for Sign in as. */
export async function codeIsRecent(session: AdminSession): Promise<boolean> {
  if (!session.codeVerifiedAt) return false;
  const settings = await getSettings();
  return Date.now() - session.codeVerifiedAt.getTime() <= Number(settings["admin.code_recency_minutes"]) * 60_000;
}
