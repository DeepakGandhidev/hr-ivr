import { NextRequest, NextResponse } from "next/server";
import { adminPrisma } from "@pratibha/prisma";
import { handleApi } from "@/lib/api-errors";
import { NotFoundError, ValidationError } from "@pratibha/shared";
import { z } from "zod";

const attachmentSchema = z.object({
  filename: z.string(),
  contentBase64: z.string(),
});

const emailForwardSchema = z.object({
  from: z.string().email(),
  subject: z.string(),
  body: z.string(),
  attachments: z.array(attachmentSchema).default([]),
});

export async function POST(
  request: NextRequest,
  { params }: { params: { tenantSlug: string } }
) {
  const { tenantSlug } = params;
  return handleApi(async () => {
    // Inbound mail arrives with no session, so there is no tenant context and
    // RLS would hide everything. The tenant is resolved from the URL slug and
    // every write below is pinned to that tenant id explicitly.
    const tenant = await adminPrisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) {
      throw new NotFoundError("Tenant not found");
    }

    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");
    if (!jobId) {
      throw new ValidationError("jobId query parameter is required");
    }

    const job = await adminPrisma.job.findUnique({
      where: { id: jobId, tenantId: tenant.id },
    });
    if (!job) {
      throw new NotFoundError("Job not found");
    }

    const body = await request.json();
    const parsed = emailForwardSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid email forward payload", parsed.error.flatten());
    }

    // Derive a readable candidate name from the From header when possible.
    const fromHeader = parsed.data.from;
    const nameMatch = fromHeader.match(/^(.+?)\s*</);
    const name = nameMatch ? nameMatch[1].trim() : null;

    const candidate = await adminPrisma.candidate.create({
      data: {
        tenantId: tenant.id,
        jobId: job.id,
        name,
        email: fromHeader,
        sourceEmailMsgId: `${Date.now()}-${fromHeader}`,
        cvParsed: {
          subject: parsed.data.subject,
          body: parsed.data.body,
          attachments: parsed.data.attachments.map((a) => a.filename),
        },
        parseFailed: false,
      },
    });

    // TODO: queue CV parsing / attachment extraction in a background worker.

    return NextResponse.json({ candidate }, { status: 201 });
  });
}
