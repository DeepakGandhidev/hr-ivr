import { type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handle, parseBody, AdminApiError, badRequest } from "@/lib/http";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { createSession, hashToken, panelEnabled } from "@/lib/auth/session";
import { recordActivity } from "@/lib/activity";

export const runtime = "nodejs";

const schema = z.object({
  token: z.string().min(20),
  password: z.string().min(1, "Choose a password."),
});

/** An invited admin sets their password; the invite link then stops working. */
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    if (!panelEnabled()) throw new AdminApiError(404, "NOT_FOUND", "Not found");
    const { token, password } = await parseBody(request, schema);

    const admin = await db.adminUser.findUnique({ where: { inviteTokenHash: hashToken(token) } });
    if (!admin || admin.deactivatedAt || !admin.inviteExpiresAt || admin.inviteExpiresAt < new Date()) {
      throw new AdminApiError(410, "INVITE_EXPIRED", "This invite has expired or was already used. Ask an Owner for a new one.");
    }

    const problem = passwordProblem(password, admin.email);
    if (problem) throw badRequest(problem);

    await db.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash: await hashPassword(password), inviteTokenHash: null, inviteExpiresAt: null },
    });
    await createSession(admin.id, "active");
    await recordActivity({ actor: admin, action: "admin.invite_accepted", summary: `${admin.name} accepted their admin invite` });
    return { next: "/account/two-step" };
  });
}
