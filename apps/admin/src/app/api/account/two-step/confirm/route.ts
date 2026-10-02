import { type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handle, parseBody, badRequest, conflict } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { verifyTotp } from "@/lib/auth/totp";
import { openTotp } from "@/lib/auth/secrets";
import { recordActivity } from "@/lib/activity";

export const runtime = "nodejs";

const schema = z.object({ code: z.string().trim().min(6, "Enter the six digit code.") });

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin, session } = await requireAdmin("view");
    if (admin.totpEnabledAt) throw conflict("Two step verification is already on for your account.");
    const { code } = await parseBody(request, schema);

    if (!admin.totpSecret) throw badRequest("Start enrolment first.");
    if (!verifyTotp(openTotp(admin.totpSecret), code)) {
      throw badRequest("That code is not right. Check the app shows Pratibha Admin and try the current code.");
    }

    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.adminUser.update({ where: { id: admin.id }, data: { totpEnabledAt: now } });
      await tx.adminSession.update({ where: { id: session.id }, data: { codeVerifiedAt: now } });
      await recordActivity(
        { actor: admin, action: "admin.two_step_enabled", summary: `${admin.name} turned on two step verification` },
        tx
      );
    });
    return { ok: true };
  });
}
