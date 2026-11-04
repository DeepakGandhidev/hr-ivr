import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // P01: a token refresh made here is still the browser's session, so
      // GoTrue records the browser's own user agent rather than this runtime's
      // ("Next.js Middleware").
      global: { headers: forwardedHeaders(request.headers) },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({
            request: {
              headers: request.headers,
            },
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // refreshing the auth token
  await supabase.auth.getUser();

  return supabaseResponse;
}

/** The browser's identity, passed through on server-side calls to GoTrue. */
export function forwardedHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const ua = h.get("user-agent");
  if (ua) out["User-Agent"] = ua;
  const ip = h.get("x-forwarded-for") ?? h.get("x-real-ip");
  if (ip) out["X-Forwarded-For"] = ip;
  return out;
}
