import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { headers } from "next/headers";
import { Reader } from "mmdb-lib";
import { adminPrisma } from "@pratibha/prisma";
import { bearerToken, createClient } from "@/lib/supabase/server";

/**
 * Batch 5, P01 and P16: the device and place a browser session started from.
 *
 * Written once per GoTrue session, the first time that session makes a request
 * from a browser, and never again. Server-side work (middleware refreshing a
 * token, a route re-checking a password) never writes here, which is what lets
 * "Next.js Middleware" disappear from the sessions list for good.
 *
 * Location comes from DB-IP's free city database, read from disk on this
 * server. No IP address leaves the machine, so there is no new subprocessor.
 * The database is CC BY 4.0: the sessions card carries the required link.
 */

const recorded = new Set<string>();

/** The session id inside the access token, without a network call. */
export function sessionIdFromToken(accessToken: string | null | undefined): string | null {
  if (!accessToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.session_id === "string" ? payload.session_id : null;
  } catch {
    return null;
  }
}

/** The current browser session's id, from its cookie. */
export async function currentSessionId(): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  return sessionIdFromToken(data.session?.access_token);
}

/** The caller's address, as the reverse proxy saw it. */
export function clientIp(h: Headers): string | null {
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip") || null;
}

let reader: { db: Reader<Record<string, unknown>>; v6: boolean } | null = null;
let readerV6: { db: Reader<Record<string, unknown>> } | null = null;
let dropTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Where the database files are: GEOIP_DB_DIR if set, else the installed
 * package, found by walking up from the app (npm workspaces hoist it to the
 * repository root). Resolved by path because the server bundle replaces
 * require.resolve.
 */
function dbDir(): string {
  if (process.env.GEOIP_DB_DIR) return process.env.GEOIP_DB_DIR;
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "node_modules", "@ip-location-db", "dbip-city-mmdb");
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("The DB-IP city database is not installed (@ip-location-db/dbip-city-mmdb)");
}

function openDb(file: string) {
  return new Reader<Record<string, unknown>>(readFileSync(path.join(dbDir(), file)));
}

/**
 * City and country for an address, or null. The database is only loaded while
 * sessions are being recorded and is let go a few minutes later, since new
 * sign-ins are rare and the file is large.
 */
export function geolocate(ip: string | null): { city: string | null; country: string | null } | null {
  if (!ip) return null;
  try {
    const v6 = ip.includes(":") && !ip.startsWith("::ffff:");
    const addr = ip.replace(/^::ffff:/, "");
    let rec: Record<string, unknown> | null;
    if (v6) {
      readerV6 ??= { db: openDb("dbip-city-ipv6.mmdb") };
      rec = readerV6.db.get(addr);
    } else {
      reader ??= { db: openDb("dbip-city-ipv4.mmdb"), v6: false };
      rec = reader.db.get(addr);
    }
    if (dropTimer) clearTimeout(dropTimer);
    dropTimer = setTimeout(() => {
      reader = null;
      readerV6 = null;
    }, 5 * 60_000);
    if (!rec) return null;
    const code = typeof rec.country_code === "string" ? rec.country_code : null;
    let country: string | null = code;
    try {
      if (code) country = new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
    } catch {
      // Keep the code.
    }
    const city = typeof rec.city === "string" && rec.city ? rec.city : null;
    return { city, country };
  } catch (err) {
    console.error("Geolocation lookup failed", err);
    return null;
  }
}

/**
 * Record where this browser session came from, if it has not been recorded.
 * Fire and forget: it must never slow or fail the request it rides on.
 */
export function noteSessionOrigin(userId: string): void {
  try {
    // Native clients present a bearer token; they are not browser sign-ins.
    if (bearerToken()) return;
    // Request-scoped reads happen now, while the request is still in scope.
    const h = headers();
    const userAgent = h.get("user-agent")?.slice(0, 500) ?? null;
    const ip = clientIp(h);
    const session = currentSessionId();
    void (async () => {
      const sessionId = await session;
      if (!sessionId || recorded.has(sessionId)) return;
      recorded.add(sessionId);
      const place = geolocate(ip);
      await adminPrisma.sessionOrigin.createMany({
        data: [{ sessionId, userId, userAgent, ip, city: place?.city ?? null, country: place?.country ?? null }],
        skipDuplicates: true,
      });
    })().catch((err) => console.error("Session origin not recorded", err));
  } catch (err) {
    console.error("Session origin not recorded", err);
  }
}
