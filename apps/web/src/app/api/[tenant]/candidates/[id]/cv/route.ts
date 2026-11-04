import { NextRequest, NextResponse } from "next/server";
import { Action, NotFoundError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { storage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The stored CV file, shown in the browser rather than downloaded (PL81).
 * Only PDFs and images are served inline; anything else is a download, since
 * an inline document of another type could carry script into our origin.
 */
export async function GET(request: NextRequest, { params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const ref = await withTenantAuth(tenant, Action.candidateRead, async (_ctx, tx) => {
      const c = await tx.candidate.findUnique({ where: { id }, select: { cvFileRef: true } });
      if (!c?.cvFileRef) throw new NotFoundError("No CV file is stored for this candidate.");
      return c.cvFileRef;
    });
    const file = await storage.get(ref);
    if (!file) throw new NotFoundError("No CV file is stored for this candidate.");
    const inline = file.contentType === "application/pdf" || /^image\/(png|jpeg|webp)$/.test(file.contentType);
    return new NextResponse(new Uint8Array(file.body), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": inline ? "inline" : "attachment",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });
}
