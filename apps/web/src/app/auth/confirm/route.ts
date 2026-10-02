import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const TYPES = ["magiclink", "recovery", "invite", "email", "signup"] as const;

/**
 * Exchange a one-time token for a session, then go on.
 *
 * The standard landing for a GoTrue link: a password reset, an invite, or a
 * single-use sign in issued by the Pratibha team for support. The token is
 * GoTrue's and is verified by GoTrue; this route only sets the resulting
 * session cookie. `next` must be a path on this site, never another origin.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const token = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as (typeof TYPES)[number] | null;
  const nextParam = url.searchParams.get("next") ?? "/login";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/login";

  if (!token || !type || !TYPES.includes(type)) {
    return NextResponse.redirect(new URL("/login?link=invalid", url));
  }

  const supabase = createClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: token, type });
  if (error) {
    return NextResponse.redirect(new URL("/login?link=expired", url));
  }
  return NextResponse.redirect(new URL(next, url));
}
