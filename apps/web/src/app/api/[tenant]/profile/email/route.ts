import { NextRequest, NextResponse } from "next/server";
import { Action, ValidationError, writeAuditLog } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { z } from "zod";

export const runtime = "nodejs";

const emailSchema = z.object({
  email: z.string().trim().email("That does not look like an email address"),
  currentPassword: z.string().min(1, "Enter your current password"),
});

/**
 * Change the address you sign in with.
 *
 * The email is the login identity, so this is a credential change, not a
 * profile edit, and it is treated like one: the current password is required,
 * and the new address must be confirmed before it takes effect.
 *
 * Our `users` row is deliberately NOT updated here. GoTrue holds the pending
 * change until the new address is verified, and writing our copy first would
 * leave the app showing an address the person cannot actually sign in with —
 * and, if they never confirm, no way back. The row is reconciled when the
 * verified address next resolves a session.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = emailSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Invalid email change", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateRead);
    const nextEmail = parsed.data.email.toLowerCase();

    if (nextEmail === ctx.user.email.toLowerCase()) {
      throw new ValidationError("That is already your email address.");
    }

    const supabase = createClient();

    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: ctx.user.email,
      password: parsed.data.currentPassword,
    });
    if (reauthError) {
      return NextResponse.json(
        { error: "INVALID_PASSWORD", message: "That is not your current password." },
        { status: 400 }
      );
    }

    // GoTrue sends the confirmation and holds the change until it is followed.
    const { error } = await supabase.auth.updateUser({ email: nextEmail });
    if (error) throw new ValidationError(error.message);

    await tx(async (db) => {
      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "user.email.change_requested",
        entity: "user",
        entityId: ctx.user.id,
        before: { email: ctx.user.email },
        after: { email: nextEmail, confirmed: false },
      });
    });

    // The OLD address is told, because that is the one a thief would be trying
    // to move away from. The new address gets GoTrue's confirmation link.
    await sendEmail({
      to: ctx.user.email,
      subject: "A change of email address was requested on your Pratibha account",
      body:
        `Hello${ctx.user.name ? ` ${ctx.user.name}` : ""},\n\n` +
        `Someone asked to change the email address on your Pratibha account ` +
        `from ${ctx.user.email} to ${nextEmail}. It will not take effect until ` +
        `the new address is confirmed.\n\n` +
        `If this was not you, change your password now and contact your ` +
        `workspace owner.\n`,
    }).catch(() => {});

    return NextResponse.json({
      ok: true,
      pendingEmail: nextEmail,
      message: `Check ${nextEmail} for a confirmation link. Your current address stays active until then.`,
    });
  });
}
