import { NextRequest } from "next/server";
import {
  Action,
  callWindowSchema,
  NotFoundError,
  ValidationError,
} from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";

const querySchema = z.object({
  jobId: z.string().min(1).optional(),
});

const createCallWindowSchema = callWindowSchema.extend({
  jobId: z.string().min(1),
});

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    // jobId is optional: the Settings screen lists one window per job, so it
    // asks for all of them at once. RLS still scopes the result to the tenant.
    const { searchParams } = new URL(request.url);
    const jobIdParam = searchParams.get("jobId");
    const query = querySchema.safeParse({ jobId: jobIdParam ?? undefined });
    if (jobIdParam !== null && !query.success) {
      throw new ValidationError("Invalid jobId query parameter", query.error.flatten());
    }

    return withTenantAuth(tenant, Action.settingsUpdate, async (_ctx, tx) => {
      const windows = await tx.callWindow.findMany({
        ...(jobIdParam ? { where: { jobId: jobIdParam } } : {}),
        orderBy: { createdAt: "desc" },
      });
      return { windows };
    });
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const body = await request.json();
    // The window fields are expected at the top level. The settings page used
    // to post them wrapped as { window: {...} }, which failed validation for
    // every value a user could enter — the screen had never saved once.
    const parsed = createCallWindowSchema.safeParse(body);
    if (!parsed.success) {
      const fields = Object.keys(parsed.error.flatten().fieldErrors).join(", ");
      throw new ValidationError(
        fields ? `Invalid call window: check ${fields}` : "Invalid call window payload",
        parsed.error.flatten()
      );
    }

    return withTenantAuth(tenant, Action.settingsUpdate, async (_ctx, tx) => {
      const job = await tx.job.findUnique({ where: { id: parsed.data.jobId } });
      if (!job) {
        throw new NotFoundError("Job not found");
      }

      // Saving replaces the job's window rather than adding another. There is
      // no unique constraint on jobId, so a plain create meant every press of
      // Save appended a row, and isWithinCallWindow accepts a call matching
      // ANY window — so a corrected window could never actually narrow
      // availability, because the old, wider one was still there.
      // withTenantAuth already runs this callback inside a transaction, so the
      // delete and the create commit together without opening a nested one.
      await tx.callWindow.deleteMany({ where: { jobId: parsed.data.jobId } });
      const window = await tx.callWindow.create({
        data: {
          jobId: parsed.data.jobId,
          timezone: parsed.data.timezone,
          days: parsed.data.days,
          startTime: parsed.data.startTime,
          endTime: parsed.data.endTime,
        },
      });

      return { window };
    });
  });
}
