import { createClient } from "@supabase/supabase-js";

/**
 * Check a password without starting a session that lingers (P01).
 *
 * GoTrue can only check a password by signing in, and signing in creates a
 * session. Done through the cookie client, that replaced the browser's own
 * session and left the old one behind as a row nobody would ever use. This
 * signs in on a throwaway client with no cookies and no storage, and signs
 * that session straight back out, so the browser's session is untouched and
 * nothing is left in auth.sessions.
 */
export async function passwordMatches(email: string, password: string): Promise<boolean> {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) return false;
  await client.auth.signOut({ scope: "local" }).catch(() => {});
  return true;
}
