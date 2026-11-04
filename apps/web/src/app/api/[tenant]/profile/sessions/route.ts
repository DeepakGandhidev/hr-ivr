import { NextRequest, NextResponse } from "next/server";
import { Action, describeUserAgent, ValidationError, writeAuditLog } from "@pratibha/shared";
import { adminPrisma } from "@pratibha/prisma";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { createClient } from "@/lib/supabase/server";
import { authDb } from "@/lib/auth-db";
import { currentSessionId } from "@/lib/session-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read as JSON so a GoTrue without refreshed_at or not_after still works. */
interface SessionRow {
  id: string;
  created_at?: string | null;
  updated_at?: string | null;
  refreshed_at?: string | null;
  not_after?: string | null;
  user_agent?: string | null;
  ip?: string | null;
}

/** refreshed_at is stored without a zone, in UTC. */
const at = (v: string | null | undefined) => (v ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`) : null);

/**
 * Where this account is signed in (Batch 5, P01, P15, P16).
 *
 * One row per GoTrue session: auth.sessions is the record of what can actually
 * be used, so a session ended there is gone here too. The device and place come
 * from session_origins, written once from the browser that signed in, because
 * GoTrue's own user_agent column is rewritten by every server-side refresh.
 * "Last seen" is GoTrue's refresh time, updated in place.
 *
 * The query is pinned to this user's own auth id, taken from the session rather
 * than from anything the caller sent.
 */
export async function GET(request: NextRequest, { params }: { params: { tenant: string } }) {
  const { tenant } = params;
  return handleApi(async () => {
    const { ctx } = await authorizeTenant(tenant, Action.candidateRead);
    if (!ctx.user.authProviderId) return { sessions: [] };

    const [raw, current] = await Promise.all([
      authDb.$queryRaw<{ row: SessionRow }[]>`
        SELECT to_jsonb(s) AS row FROM auth.sessions s
        WHERE s.user_id = ${ctx.user.authProviderId}::uuid`,
      currentSessionId(),
    ]);
    const now = Date.now();
    const rows = raw
      .map((r) => r.row)
      .filter((r) => !r.not_after || (at(r.not_after)?.getTime() ?? 0) > now)
      .map((r) => ({ ...r, lastSeen: at(r.refreshed_at) ?? at(r.updated_at) ?? at(r.created_at) }))
      .sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0))
      .slice(0, 50);
    const origins = await adminPrisma.sessionOrigin.findMany({ where: { sessionId: { in: rows.map((r) => r.id) } } });
    const byId = new Map(origins.map((o) => [o.sessionId, o]));

    return {
      sessions: rows.map((row) => {
        const origin = byId.get(row.id);
        const ip = origin?.ip ?? (row.ip ? String(row.ip).replace(/\/\d+$/, "") : null);
        const place = [origin?.city, origin?.country].filter(Boolean).join(", ");
        return {
          id: row.id,
          current: row.id === current,
          device: describeUserAgent(origin?.userAgent ?? row.user_agent),
          place: place || null,
          ip,
          createdAt: at(row.created_at),
          lastSeenAt: row.lastSeen,
        };
      }),
    };
  });
}

/**
 * Sign out one device (?id=), or everywhere else (no id).
 *
 * Everywhere else is scoped to `others` so the person doing it stays signed
 * in. A single device is ended by deleting its GoTrue session, which takes its
 * refresh tokens with it; this device cannot be ended from here.
 */
export async function DELETE(request: NextRequest, { params }: { params: { tenant: string } }) {
  const { tenant } = params;
  return handleApi(async () => {
    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateRead);
    const one = request.nextUrl.searchParams.get("id");

    if (one) {
      if (!ctx.user.authProviderId) throw new ValidationError("No sessions to end.");
      if (one === (await currentSessionId())) {
        throw new ValidationError("This is the device you are using. Sign out from the menu instead.");
      }
      const removed = await authDb.$executeRaw`
        DELETE FROM auth.sessions WHERE id = ${one}::uuid AND user_id = ${ctx.user.authProviderId}::uuid`;
      await adminPrisma.sessionOrigin.deleteMany({ where: { sessionId: one, userId: ctx.user.id } });
      await tx(async (db) => {
        await writeAuditLog(db, {
          tenantId: ctx.tenant.id,
          actor: ctx.user.id,
          action: "user.session.revoked",
          entity: "user",
          entityId: ctx.user.id,
          after: { sessionId: one, removed },
        });
      });
      return NextResponse.json({ ok: true, removed });
    }

    const supabase = createClient();
    const { error } = await supabase.auth.signOut({ scope: "others" });

    await tx(async (db) => {
      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "user.sessions.revoked",
        entity: "user",
        entityId: ctx.user.id,
        after: { succeeded: !error },
      });
    });

    if (error) {
      return NextResponse.json({ error: "SIGN_OUT_FAILED", message: error.message }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  });
}
