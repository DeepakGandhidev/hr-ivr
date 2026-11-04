import { NextRequest, NextResponse } from "next/server";
import { Action, ValidationError, writeAuditLog } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { createClient } from "@/lib/supabase/server";
import { passwordMatches } from "@/lib/reauth";
import { sendEmail } from "@/lib/email";
import { passwordChangedEmail } from "@/lib/copy-emails";
import { setting } from "@pratibha/shared/settings-runtime";
import { z } from "zod";

export const runtime = "nodejs";

/** Built per request: the minimum length is set in the admin panel (Security). */
function passwordSchema(minLength: number) {
  return z.object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z.string().min(minLength, `Use at least ${minLength} characters`),
  });
}

/**
 * Change your own password.
 *
 * Three things happen, and all three matter:
 *
 *  1. The current password is verified first. Without it, anyone who finds an
 *     unlocked laptop owns the account permanently, and a session hijack
 *     becomes a password reset.
 *  2. Every other session is ended. The reason people change a password is that
 *     they think someone else has it, and leaving that someone signed in
 *     defeats the entire exercise.
 *  3. A notification goes to the account. If the person reading it did not do
 *     this, that email is the only warning they will get.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = passwordSchema(setting<number>("security.password_min_length")).safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      throw new ValidationError("Invalid password change", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateRead);
    const supabase = createClient();

    // Re-authenticate against this user's own email, so it cannot be used to
    // probe anyone else's. Checked on a throwaway client: signing in through
    // the cookie client used to replace this browser's session with a new one
    // and leave the old row behind (Batch 5, P01).
    const reauthOk = await passwordMatches(ctx.user.email, parsed.data.currentPassword);

    if (!reauthOk) {
      // Deliberately not distinguishing "wrong password" from anything else in
      // the response, while still recording the attempt.
      await tx(async (db) => {
        await writeAuditLog(db, {
          tenantId: ctx.tenant.id,
          actor: ctx.user.id,
          action: "user.password.change_failed",
          entity: "user",
          entityId: ctx.user.id,
          reason: "current password did not match",
        });
      });

      return NextResponse.json(
        { error: "INVALID_PASSWORD", message: "That is not your current password." },
        { status: 400 }
      );
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password: parsed.data.newPassword,
    });

    if (updateError) {
      throw new ValidationError(updateError.message);
    }

    // Ends every other session, keeping this one. The scope matters: signing
    // this session out too would leave the person unsure whether the change
    // even took effect.
    const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });

    await tx(async (db) => {
      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "user.password.changed",
        entity: "user",
        entityId: ctx.user.id,
        after: { otherSessionsEnded: !signOutError },
      });
    });

    // After the change, never before: a failed notification must not stop a
    // password change that has already happened.
    const email = passwordChangedEmail({ name: ctx.user.name, email: ctx.user.email });
    await sendEmail({ kind: "account_password_changed", tenantId: ctx.tenant.id, to: ctx.user.email, subject: email.subject, body: email.body }).catch(() => {
      // Logged by sendEmail. The change stands either way.
    });

    return NextResponse.json({ ok: true, otherSessionsEnded: !signOutError });
  });
}
