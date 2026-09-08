import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Paths that do not require a tenant context
const PUBLIC_PATHS = [
  "/signup",
  "/login",
  "/verify-email",
  "/auth",
  "/api/auth",
  "/j/",
  "/webhook/",
  "/_next/",
  "/favicon.ico",
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Let public paths through after refreshing session cookies
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return updateSession(request);
  }

  const response = await updateSession(request);

  // Tenant extraction: /:tenantSlug/... or subdomain
  const host = request.headers.get("host") ?? "";
  const tenantSlugFromSubdomain = host.split(".")[0];
  const pathParts = pathname.split("/").filter(Boolean);
  const tenantSlugFromPath = pathParts[0];

  // For P0 we use path-based tenant slug (subdomain is P1/P2)
  const tenantSlug = tenantSlugFromPath;

  if (!tenantSlug || !/^[a-z0-9-]+$/.test(tenantSlug)) {
    return NextResponse.json({ error: "Invalid or missing tenant" }, { status: 400 });
  }

  response.headers.set("x-tenant-slug", tenantSlug);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
