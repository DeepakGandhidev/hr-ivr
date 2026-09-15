import { NextRequest, NextResponse } from "next/server";
import { Action, NotFoundError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { storage, etagFor } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * Serve one tenant asset.
 *
 * Through the app rather than from a public directory, so row-level security
 * decides who sees it: a logo is not secret, but a profile photo is a picture
 * of a named employee, and a public URL for one is a public URL for all of
 * them. Served by id, so the storage key never reaches a browser and the
 * storage driver stays swappable.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.candidateRead, async (_ctx, tx) => {
      const asset = await tx.tenantAsset.findUnique({
        where: { id },
        select: { storageKey: true, contentType: true },
      });
      if (!asset) throw new NotFoundError("Asset not found");

      const object = await storage.get(asset.storageKey);
      // The row can outlive its bytes — storage swapped, a partial restore.
      if (!object) throw new NotFoundError("Asset file is missing");

      const etag = etagFor(object.body);
      if (request.headers.get("if-none-match") === etag) {
        return new NextResponse(null, { status: 304 });
      }

      // Buffer is a Uint8Array, but NextResponse's types do not accept the
      // Node subclass directly; a plain view over the same bytes copies nothing.
      return new NextResponse(new Uint8Array(object.body), {
        status: 200,
        headers: {
          "Content-Type": asset.contentType,
          "Content-Length": String(object.body.byteLength),
          ETag: etag,
          // Private: these are tenant files behind an authorisation check, and
          // a shared cache holding them would serve one tenant's logo from
          // another tenant's request.
          "Cache-Control": "private, max-age=300, must-revalidate",
          // SVG can carry script. Forbidding sniffing and refusing to frame it
          // stops an uploaded SVG executing in our origin — the one real risk
          // in accepting the format at all.
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      });
    })
  );
}
