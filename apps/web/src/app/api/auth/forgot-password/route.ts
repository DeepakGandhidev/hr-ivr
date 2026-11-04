import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@pratibha/shared";
import { handleApi } from "@/lib/api-errors";
import { requestPasswordReset } from "@/lib/auth-emails";

export const runtime = "nodejs";

const schema = z.object({ email: z.string().trim().email("That does not look like an email address") });

/**
 * "Forgot password?": email a reset link from Pratibha's mailbox.
 *
 * The answer is the same whether or not the address has an account, whether
 * it was sent or held back by the once-per-ten-minutes limit, and whether the
 * mailbox worked: anything else would let the form be used to find out who
 * has an account here. What actually happened is in email_log and the server
 * log.
 */
export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Invalid email", parsed.error.flatten());

    try {
      await requestPasswordReset(parsed.data.email, request.nextUrl.origin);
    } catch (err) {
      console.error("[forgot-password] reset link not sent:", err);
    }
    return NextResponse.json({ ok: true });
  });
}
