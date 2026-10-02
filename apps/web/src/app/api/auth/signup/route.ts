import { NextRequest, NextResponse } from "next/server";
import { adminPrisma } from "@pratibha/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  createTenantSchema,
  DEFAULT_OUTREACH_TEMPLATES,
  DEFAULT_PROTOCOL_INSTRUCTION,
  PLANS,
  ValidationError,
} from "@pratibha/shared";
import { currentPlan, currentTrial, trialAllowance } from "@/lib/pricing";
import { handleApi } from "@/lib/api-errors";

export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const body = await request.json();
    const parsed = createTenantSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid signup payload", parsed.error.flatten());
    }

    const { name, slug, ownerEmail, ownerName, password } = parsed.data;

    // Signup is what creates the tenant, so this check predates any tenant context.
    const existingSlug = await adminPrisma.tenant.findUnique({ where: { slug } });
    if (existingSlug) {
      return NextResponse.json(
        { error: "DUPLICATE_SLUG", message: "Workspace slug is already taken" },
        { status: 409 }
      );
    }

    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email: ownerEmail,
      password,
      options: {
        data: { name: ownerName ?? "" },
      },
    });

    if (error) {
      if (error.message.toLowerCase().includes("already registered")) {
        return NextResponse.json(
          { error: "DUPLICATE_EMAIL", message: "Email is already registered" },
          { status: 409 }
        );
      }
      throw new Error(error.message);
    }

    const authUserId = data.user?.id;
    if (!authUserId) {
      throw new Error("Supabase did not return a user after signup");
    }

    // New signups take what is published now: the newest Starter version and
    // the live trial's length.
    const [starter, trial] = await Promise.all([currentPlan("starter"), currentTrial()]);
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + trialAllowance(trial).days);

    try {
      const result = await adminPrisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name,
            slug,
            planId: starter?.id ?? PLANS.starter.id,
            status: "trial",
            trialEndsAt,
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
          data: DEFAULT_OUTREACH_TEMPLATES.map((t) => ({ ...t, tenantId: tenant.id, isDefault: true })),
        });

        await tx.interviewProtocol.create({
          data: {
            tenantId: tenant.id,
            jobId: null,
            instructionText: DEFAULT_PROTOCOL_INSTRUCTION,
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

      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      // TODO: clean up orphaned Supabase auth user on rollback (requires service role key).
      throw err;
    }
  });
}
