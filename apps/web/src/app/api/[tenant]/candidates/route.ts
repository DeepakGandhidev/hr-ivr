import { NextRequest, NextResponse } from "next/server";
import {
  Action,
  MAX_CV_UPLOAD_FILES,
  MAX_CV_UPLOAD_TOTAL_BYTES,
  manualCandidateSchema,
  NotFoundError,
  ValidationError,
} from "@pratibha/shared";
import { authorizeTenant, withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { ingestCvFile, ingestManualCandidate, type IngestFileResult } from "@/lib/cv-intake";
import { z } from "zod";

/**
 * pdf-parse loads pdf.js, which reaches for Node built-ins and its own worker.
 * Bundling it into the route breaks both, so this handler runs on the Node
 * runtime and the package is left external in next.config.mjs.
 */
export const runtime = "nodejs";

/** Decoding a hundred PDFs sequentially outruns the default serverless budget. */
export const maxDuration = 300;

const querySchema = z.object({
  jobId: z.string().min(1),
});

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const { searchParams } = new URL(request.url);
    const query = querySchema.safeParse({ jobId: searchParams.get("jobId") });
    if (!query.success) {
      throw new ValidationError("jobId query parameter is required", query.error.flatten());
    }

    return withTenantAuth(tenant, Action.candidateRead, async (_ctx, tx) => {
      const candidates = await tx.candidate.findMany({
        where: { jobId: query.data.jobId },
        orderBy: { createdAt: "desc" },
        include: {
          screenings: { orderBy: { createdAt: "desc" }, take: 1 },
          shortlistItems: { include: { shortlist: true } },
        },
      });

      return { candidates };
    });
  });
}

/**
 * Add candidates to a job by hand — §5 Stage 4 without a mailbox.
 *
 * Two request shapes, because they are the same operation with different
 * inputs rather than two features:
 *   multipart/form-data  jobId + one or many `files`   — CV upload, bulk or not
 *   application/json     jobId + name/email/phone      — typed in directly
 *
 * Bulk is deliberately not all-or-nothing. A recruiter importing a folder of a
 * hundred CVs will have a scan or a stray .xlsx among them, and failing the
 * whole request over one file means they cannot tell which one, and have to
 * redo the other ninety-nine. Each file gets its own outcome and the response
 * reports them all; the status code reflects whether anything landed.
 *
 * One request carries up to MAX_CV_UPLOAD_FILES. The UI splits a large
 * selection into smaller requests for progress and to stay under proxy body
 * limits, but that is its choice — a direct API caller may send the lot.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const contentType = request.headers.get("content-type") ?? "";
    const isUpload = contentType.includes("multipart/form-data");

    // Read the body before authorizing so a malformed request fails as a 400
    // rather than holding a transaction open while the upload streams in.
    const form = isUpload ? await request.formData() : null;
    const json = isUpload ? null : await request.json().catch(() => null);

    // authorizeTenant, not withTenantAuth: parsing a PDF takes longer than the
    // 5-second interactive-transaction timeout, so the work happens between
    // short transactions rather than inside one long one.
    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateCreate);

    const jobId = isUpload ? String(form!.get("jobId") ?? "") : String(json?.jobId ?? "");
    if (!jobId) {
      throw new ValidationError("jobId is required");
    }

    // The job is confirmed to exist inside the tenant transaction, so RLS is
    // what proves it belongs to this tenant — not a filter we remembered to add.
    const job = await tx((db) => db.job.findUnique({ where: { id: jobId } }));
    if (!job) {
      throw new NotFoundError("Job not found");
    }

    if (!isUpload) {
      const parsed = manualCandidateSchema.safeParse({ ...json, jobId });
      if (!parsed.success) {
        throw new ValidationError("Invalid candidate payload", parsed.error.flatten());
      }
      const result = await ingestManualCandidate(ctx.tenant.id, parsed.data, ctx.user.id, tx);
      return NextResponse.json(
        { results: [result], summary: summarize([result]) },
        { status: result.status === "created" ? 201 : 200 }
      );
    }

    const files = form!.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) {
      throw new ValidationError("Attach at least one CV file");
    }
    if (files.length > MAX_CV_UPLOAD_FILES) {
      throw new ValidationError(
        `Up to ${MAX_CV_UPLOAD_FILES} CVs per request. You attached ${files.length}.`
      );
    }

    // The file count alone does not bound the request: a hundred files at the
    // per-file ceiling is over a gigabyte, and formData() has already buffered
    // it. Checking here still protects the parse loop and the database from a
    // batch that is within the count but absurd in size.
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_CV_UPLOAD_TOTAL_BYTES) {
      throw new ValidationError(
        `That batch is ${Math.round(totalBytes / (1024 * 1024))}MB, over the ` +
          `${Math.round(MAX_CV_UPLOAD_TOTAL_BYTES / (1024 * 1024))}MB limit for one request. ` +
          `Send fewer CVs at a time.`
      );
    }

    // Sequential, not Promise.all: each file opens its own short transaction,
    // and firing a hundred at once would exhaust the connection pool while a
    // hundred pdf.js workers competed for the same event loop.
    const results: IngestFileResult[] = [];
    for (const file of files) {
      results.push(await ingestCvFile(ctx.tenant.id, jobId, file, ctx.user.id, tx));
    }

    const summary = summarize(results);
    return NextResponse.json(
      { results, summary },
      // Nothing landed at all is a failed request, not a successful one with sad
      // contents — a client that only checks res.ok must not read it as success.
      { status: summary.created + summary.merged === 0 ? 422 : 201 }
    );
  });
}

function summarize(results: IngestFileResult[]) {
  return {
    total: results.length,
    created: results.filter((r) => r.status === "created").length,
    merged: results.filter((r) => r.status === "merged").length,
    failed: results.filter((r) => r.status === "failed").length,
    /** Read, stored, but yielded no name, email or phone — needs a human. */
    unparsed: results.filter((r) => r.status !== "failed" && r.parseFailed).length,
  };
}
