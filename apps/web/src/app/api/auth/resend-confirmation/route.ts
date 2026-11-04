import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@pratibha/shared";
import { handleApi } from "@/lib/api-errors";
import { resendSignupConfirmation } from "@/lib/auth-emails";

export const runtime = "nodejs";

const schema = z.object({ email: z.string().trim().email("That does not look like an email address") });

/**
 * "Send the link again" after sign-up: a fresh confirmation link from
 * Pratibha's mailbox, at most once every couple of minutes per address. Like
 * forgot-password it answers the same for every address, confirmed, waiting
 * or unknown.
 */
export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Invalid email", parsed.error.flatten());

    try {
      await resendSignupConfirmation(parsed.data.email, request.nextUrl.origin);
    } catch (err) {
      console.error("[resend-confirmation] link not sent:", err);
    }
    return NextResponse.json({ ok: true });
  });
}
