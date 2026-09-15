import { NextRequest, NextResponse } from "next/server";
import { Action, ValidationError, writeAuditLog } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { z } from "zod";

export const runtime = "nodejs";

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: z.string().min(10, "Use at least 10 characters"),
});

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
    const parsed = passwordSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Invalid password change", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateRead);
    const supabase = createClient();

    // Re-authenticate. signInWithPassword is the only way to check the current
    // password through GoTrue, and it is done against this user's own email so
    // it cannot be used to probe anyone else's.
    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: ctx.user.email,
      password: parsed.data.currentPassword,
    });

    if (reauthError) {
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
    await sendEmail({
      to: ctx.user.email,
      subject: "Your Pratibha password was changed",
      body:
        `Hello${ctx.user.name ? ` ${ctx.user.name}` : ""},\n\n` +
        `The password on your Pratibha account (${ctx.user.email}) was just changed, ` +
        `and every other signed-in device was signed out.\n\n` +
        `If this was you, there is nothing to do.\n\n` +
        `If it was not, your account is at risk: reset your password immediately ` +
        `and contact your workspace owner.\n`,
    }).catch(() => {
      // Logged by sendEmail. The change stands either way.
    });

    return NextResponse.json({ ok: true, otherSessionsEnded: !signOutError });
  });
}
