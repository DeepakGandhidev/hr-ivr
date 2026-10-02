import { type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handle, parseBody, AdminApiError } from "@/lib/http";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, panelEnabled } from "@/lib/auth/session";
import { clearAttempts, noteFailedAttempt, tooManyAttempts } from "@/lib/auth/rate-limit";
import { recordActivity } from "@/lib/activity";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().trim().toLowerCase().email("Enter your email address."),
  password: z.string().min(1, "Enter your password."),
});

/**
 * Step one: email and password, against admin_users only.
 *
 * A portal login is not checked here and could not pass: portal identities
 * live in GoTrue, this table is separate, and nothing links the two. The same
 * message covers an unknown email and a wrong password, so the form cannot be
 * used to learn who has an admin account.
 */
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    if (!panelEnabled()) throw new AdminApiError(404, "NOT_FOUND", "Not found");
    const { email, password } = await parseBody(request, schema);

    const limiterKey = `sign-in:${email}`;
    if (tooManyAttempts(limiterKey)) {
      throw new AdminApiError(429, "TOO_MANY_ATTEMPTS", "Too many attempts. Wait fifteen minutes and try again.");
    }

    const admin = await db.adminUser.findUnique({ where: { email } });
    const ok = admin && !admin.deactivatedAt && (await verifyPassword(password, admin.passwordHash));
    if (!admin || !ok) {
      noteFailedAttempt(limiterKey);
      throw new AdminApiError(401, "INVALID_CREDENTIALS", "That email and password do not match an admin account.");
    }
    clearAttempts(limiterKey);

    if (admin.totpEnabledAt) {
      await createSession(admin.id, "awaiting_code");
      return { next: "/sign-in/code" };
    }

    await createSession(admin.id, "active");
    await recordActivity({
      actor: admin,
      action: "admin.signed_in",
      summary: `${admin.name} signed in without two step verification`,
    });
    return { next: "/" };
  });
}
