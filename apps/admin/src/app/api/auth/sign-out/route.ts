import { type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handle } from "@/lib/http";
import { clearSessionCookie, lookupSession } from "@/lib/auth/session";
import { recordActivity } from "@/lib/activity";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const found = await lookupSession();
    if (found.state === "active" || found.state === "awaiting_code") {
      await db.adminSession.update({ where: { id: found.session.id }, data: { revokedAt: new Date() } });
      if (found.state === "active") {
        await recordActivity({ actor: found.admin, action: "admin.signed_out", summary: `${found.admin.name} signed out` });
      }
    }
    clearSessionCookie();
    return { next: "/sign-in" };
  });
}
