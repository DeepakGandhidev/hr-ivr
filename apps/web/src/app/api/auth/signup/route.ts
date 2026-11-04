import { NextRequest, NextResponse } from "next/server";
import { adminPrisma } from "@pratibha/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  createTenantSchema,
  defaultOutreachTemplates,
  defaultProtocolInstruction,
  PLANS,
  ValidationError,
} from "@pratibha/shared";
import { setting, settingText } from "@pratibha/shared/settings-runtime";
import { currentPlan, currentTrial, trialAllowance } from "@/lib/pricing";
import { handleApi } from "@/lib/api-errors";
import { paymentProvider } from "@/lib/payments";
import { cashfreeConfig } from "@/lib/cashfree";
import { createConfirmedUser, generateLink, GoTrueError, isEmailTaken, mailerAutoconfirm } from "@/lib/gotrue-admin";
import { sendSignupConfirmation } from "@/lib/auth-emails";

export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const body = await request.json();
    const parsed = createTenantSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid signup payload", parsed.error.flatten());
    }

    const { name, slug, ownerEmail, ownerName, password } = parsed.data;

    // The schema's own floor is 8; the admin panel (Security) sets the real one.
    const minLength = setting<number>("security.signup_password_min_length");
    if (password.length < minLength) {
      throw new ValidationError(`Use a password of at least ${minLength} characters.`, {
        formErrors: [],
        fieldErrors: { password: [`Use at least ${minLength} characters`] },
      });
    }

    // Signup is what creates the tenant, so this check predates any tenant context.
    const existingSlug = await adminPrisma.tenant.findUnique({ where: { slug } });
    if (existingSlug) {
      return NextResponse.json(
        { error: "DUPLICATE_SLUG", message: "Workspace slug is already taken" },
        { status: 409 }
      );
    }

    // The auth user is made through GoTrue's admin API, which sends nothing:
    // the confirmation goes out from Pratibha's own mailbox below. Where GoTrue
    // confirms sign-ups by itself (local development), the account is created
    // confirmed and signed straight in, as supabase.auth.signUp used to.
    const autoconfirm = await mailerAutoconfirm();
    const metadata = { name: ownerName ?? "" };
    let authUserId: string | null;
    let confirmToken: string | null = null;
    try {
      if (autoconfirm) {
        authUserId = await createConfirmedUser(ownerEmail, password, metadata);
      } else {
        const link = await generateLink({ type: "signup", email: ownerEmail, password, data: metadata });
        authUserId = link.userId;
        confirmToken = link.hashedToken;
      }
    } catch (err) {
      if (isEmailTaken(err)) {
        return NextResponse.json(
          { error: "DUPLICATE_EMAIL", message: "Email is already registered" },
          { status: 409 }
        );
      }
      // GoTrue's own rules on the address or password (e.g. a weak password).
      if (err instanceof GoTrueError && err.status < 500) throw new ValidationError(err.message);
      throw err;
    }

    if (!authUserId) {
      throw new Error("Supabase did not return a user after signup");
    }

    // New signups take what is published now: the newest Starter version and
    // the live trial's length.
    const [starter, trial] = await Promise.all([currentPlan("starter"), currentTrial()]);
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + trialAllowance(trial).days);
    // Signup is paid (the workspace waits on its first month) once Cashfree is
    // live, or when PAID_SIGNUP=true turns it on for a sandbox test. Sandbox
    // keys alone never do it: anyone could "pay" with the sandbox simulator.
    // Without a gateway that can charge, the free trial stands.
    const paid =
      paymentProvider().canCharge &&
      (cashfreeConfig()?.mode === "production" || process.env.PAID_SIGNUP === "true");

    try {
      const result = await adminPrisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name,
            slug,
            planId: starter?.id ?? PLANS.starter.id,
            status: paid ? "pending_payment" : "trial",
            trialEndsAt: paid ? null : trialEndsAt,
          },
        });

        const user = await tx.user.create({
          data: {
            tenantId: tenant.id,
            email: ownerEmail,
            name: ownerName ?? null,
            role: "owner",
            authProviderId: authUserId,
          },
        });

        await tx.outreachTemplate.createMany({
          data: defaultOutreachTemplates(settingText).map((t) => ({ ...t, tenantId: tenant.id, isDefault: true })),
        });

        await tx.interviewProtocol.create({
          data: {
            tenantId: tenant.id,
            jobId: null,
            instructionText: defaultProtocolInstruction(settingText),
            version: 1,
          },
        });

        const now = new Date();
        const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        await tx.usageMeter.create({
          data: {
            tenantId: tenant.id,
            period,
            interviewsUsed: 0,
            screeningsUsed: 0,
          },
        });

        return { tenant, user };
      });

      // "not_needed": signed in already. Otherwise the link signs them in and
      // lands on the workspace. A failed send still leaves a working account:
      // the form says so and offers to send it again.
      let confirmation: "sent" | "failed" | "not_needed" = "not_needed";
      if (confirmToken) {
        const sent = await sendSignupConfirmation({
          to: ownerEmail,
          name: ownerName,
          workspace: result.tenant.name,
          tenantId: result.tenant.id,
          tenantSlug: result.tenant.slug,
          token: confirmToken,
          origin: request.nextUrl.origin,
        }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        confirmation = sent.ok ? "sent" : "failed";
        if (!sent.ok) console.error(`[signup] confirmation to ${ownerEmail} not sent:`, sent.error);
      } else {
        const { error } = await createClient().auth.signInWithPassword({ email: ownerEmail, password });
        if (error) console.error("[signup] could not sign the new owner in:", error.message);
      }

      return NextResponse.json({ ...result, confirmation }, { status: 201 });
    } catch (err) {
      // TODO: clean up orphaned Supabase auth user on rollback (requires service role key).
      throw err;
    }
  });
}
