import { type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handle, parseBody, AdminApiError } from "@/lib/http";
import { lookupSession, panelEnabled } from "@/lib/auth/session";
import { verifyTotp } from "@/lib/auth/totp";
import { openTotp } from "@/lib/auth/secrets";
import { noteFailedAttempt, tooManyAttempts, clearAttempts } from "@/lib/auth/rate-limit";
import { recordActivity } from "@/lib/activity";

export const runtime = "nodejs";

const schema = z.object({ code: z.string().trim().min(6, "Enter the six digit code.") });

/** Step two: the code from the authenticator app turns the session active. */
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    if (!panelEnabled()) throw new AdminApiError(404, "NOT_FOUND", "Not found");
    const { code } = await parseBody(request, schema);

    const found = await lookupSession();
    if (found.state !== "awaiting_code") {
      throw new AdminApiError(401, "SESSION_ENDED", "Sign in again to enter a code.");
    }
    const { admin, session } = found;

    const limiterKey = `code:${admin.id}`;
    if (tooManyAttempts(limiterKey)) {
      throw new AdminApiError(429, "TOO_MANY_ATTEMPTS", "Too many attempts. Wait fifteen minutes and try again.");
    }

    if (!admin.totpSecret || !verifyTotp(openTotp(admin.totpSecret), code)) {
      noteFailedAttempt(limiterKey);
      throw new AdminApiError(401, "INVALID_CODE", "That code is not right. Check the app and try the current one.");
    }
    clearAttempts(limiterKey);

    await db.adminSession.update({
      where: { id: session.id },
      data: { stage: "active", codeVerifiedAt: new Date(), lastSeenAt: new Date() },
    });
    await recordActivity({ actor: admin, action: "admin.signed_in", summary: `${admin.name} signed in` });
    return { next: "/" };
  });
}
