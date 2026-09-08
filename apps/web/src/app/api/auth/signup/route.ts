import { NextRequest, NextResponse } from "next/server";
import { adminPrisma } from "@pratibha/prisma";
import { createClient } from "@/lib/supabase/server";
import { createTenantSchema, PLANS, TRIAL_DAYS, ValidationError } from "@pratibha/shared";
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

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

    try {
      const result = await adminPrisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name,
            slug,
            planId: PLANS.starter.id,
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
          data: [
            {
              tenantId: tenant.id,
              type: "interview_invite",
              subject: "Interview invite from {{companyName}} for {{jobTitle}}",
              bodyMd: `Hi {{candidateName}},

Thank you for applying for {{jobTitle}} at {{companyName}}.

We would like to invite you for a first-round screening interview with Pratibha, our AI hiring assistant.

Please call {{pratibhaNumber}} and use reference code {{referenceCode}} when prompted.

Best regards,
{{companyName}} Hiring Team`,
              isDefault: true,
            },
            {
              tenantId: tenant.id,
              type: "rejection",
              subject: "Update on your application for {{jobTitle}}",
              bodyMd: `Hi {{candidateName}},

Thank you for your interest in {{jobTitle}} at {{companyName}}.

After careful review, we have decided not to move forward with your application at this time.

We wish you the best in your search.

Best regards,
{{companyName}} Hiring Team`,
              isDefault: true,
            },
            {
              tenantId: tenant.id,
              type: "reminder",
              subject: "Reminder: Your Pratibha interview for {{jobTitle}}",
              bodyMd: `Hi {{candidateName}},

This is a friendly reminder to complete your Pratibha screening interview for {{jobTitle}} at {{companyName}}.

Call {{pratibhaNumber}} and use reference code {{referenceCode}}.

Best regards,
{{companyName}} Hiring Team`,
              isDefault: true,
            },
          ],
        });

        await tx.interviewProtocol.create({
          data: {
            tenantId: tenant.id,
            jobId: null,
            instructionText:
              "Be warm and concise. Ask one question at a time. Do not discuss salary, joining dates, or other candidates. If asked something you cannot answer, say the team will follow up.",
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
