import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies, headers } from "next/headers";

/**
 * The access token a native client sent as `Authorization: Bearer …`, if any.
 *
 * The mobile app has no browser cookie jar, so it holds its own Supabase
 * session and presents the access token on every request instead. GoTrue
 * validates it exactly as it validates the cookie session, so the tenant match,
 * role checks and RLS downstream are unchanged. Browsers never send this
 * header, so their cookie path is untouched.
 */
export function bearerToken(): string | null {
  const header = headers().get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  return match ? match[1] : null;
}

export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component calls read-only cookie; mutations happen in middleware/actions
          }
        },
      },
    }
  );
}
