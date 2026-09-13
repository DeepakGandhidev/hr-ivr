import { NextRequest, NextResponse } from "next/server";
import { adminPrisma } from "@pratibha/prisma";
import { storage, etagFor } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * A company's logo, publicly.
 *
 * The authenticated asset route cannot serve this: the careers page is public
 * and candidate emails are read in somebody else's inbox, so a logo that needs
 * a session is a broken image in both places.
 *
 * The exposure is kept as narrow as the requirement. This serves exactly one
 * file per tenant — the logo currently pinned on the company profile — reached
 * by the tenant's public slug, which is already public. There is no asset id in
 * the URL, so no other asset is addressable, and a profile photo can never be
 * reached here however it is requested: the lookup starts from the profile's
 * logo, not from an id the caller supplies.
 *
 * adminPrisma is deliberate and is why the query is written the way it is: this
 * runs with no session, so there is no tenant context for RLS to apply. The
 * only input is a slug, and the only reachable row is that tenant's logo.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenantSlug: string } }
) {
  const { tenantSlug } = params;

  const profile = await adminPrisma.companyProfile.findFirst({
    where: { tenant: { slug: tenantSlug } },
    select: {
      logo: { select: { storageKey: true, contentType: true, kind: true } },
    },
  });

  // Belt and braces: the relation can only be a logo, and it is checked anyway,
  // because this is the one route where a mistake is publicly readable.
  const logo = profile?.logo;
  if (!logo || logo.kind !== "company_logo") {
    return new NextResponse(null, { status: 404 });
  }

  const object = await storage.get(logo.storageKey);
  if (!object) return new NextResponse(null, { status: 404 });

  const etag = etagFor(object.body);
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304 });
  }

  return new NextResponse(new Uint8Array(object.body), {
    status: 200,
    headers: {
      "Content-Type": logo.contentType,
      "Content-Length": String(object.body.byteLength),
      ETag: etag,
      // Public and cacheable: it is a logo on a public page, and email clients
      // fetch it without cookies anyway.
      "Cache-Control": "public, max-age=3600, must-revalidate",
      // SVG can carry script, and this route is unauthenticated - so the
      // browser is told not to sniff, and the content policy stops anything
      // inside the file executing.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
