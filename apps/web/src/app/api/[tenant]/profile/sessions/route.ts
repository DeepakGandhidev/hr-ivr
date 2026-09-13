import { NextRequest, NextResponse } from "next/server";
import { Action, writeAuditLog } from "@pratibha/shared";
import { adminPrisma } from "@pratibha/prisma";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface SessionRow {
  id: string;
  created_at: Date | null;
  updated_at: Date | null;
  user_agent: string | null;
  ip: string | null;
}

/**
 * Where this account is signed in.
 *
 * Read straight from GoTrue's own `auth.sessions`, because GoTrue is the thing
 * that issues and ends them — a list we maintained ourselves would be a second
 * record that disagrees with reality the first time a token expires quietly.
 *
 * adminPrisma with raw SQL is deliberate: `auth` is GoTrue's schema, outside the
 * Prisma model set and outside our RLS policies. The query is therefore pinned
 * to this user's own auth id, taken from the session rather than from anything
 * the caller sent.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const { ctx } = await authorizeTenant(tenant, Action.candidateRead);

    if (!ctx.user.authProviderId) return { sessions: [] };

    const rows = await adminPrisma.$queryRaw<SessionRow[]>`
      SELECT id, created_at, updated_at, user_agent, ip
      FROM auth.sessions
      WHERE user_id = ${ctx.user.authProviderId}::uuid
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 50
    `;

    return {
      sessions: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        lastSeenAt: row.updated_at,
        // Shown as written. Parsing it into "Chrome on macOS" guesses, and a
        // wrong guess is worse here than a raw string: this list exists for
        // someone deciding whether a session is theirs.
        userAgent: row.user_agent,
        ip: row.ip,
      })),
    };
  });
}

/**
 * Sign out everywhere else.
 *
 * Scoped to `others` so the person doing it stays signed in — ending their own
 * session too leaves them unsure whether it worked, and they would sign back in
 * immediately anyway.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateRead);

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
      return NextResponse.json(
        { error: "SIGN_OUT_FAILED", message: error.message },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true });
  });
}
