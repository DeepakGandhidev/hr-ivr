import { NextResponse, type NextRequest } from "next/server";

/**
 * The dark-launch flag.
 *
 * With ADMIN_PANEL_ENABLED anything other than "true", every path answers 404,
 * sign-in included: there is no page that admits the app exists. The API
 * routes check the flag again on the Node side (requireAdmin), so a mistake
 * in this matcher cannot open them.
 */
export function middleware(request: NextRequest) {
  if (process.env.ADMIN_PANEL_ENABLED !== "true") {
    return new NextResponse("Not found", { status: 404, headers: { "X-Robots-Tag": "noindex" } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
