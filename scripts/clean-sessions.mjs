#!/usr/bin/env node
/**
 * Batch 5, P01: clear out GoTrue sessions that were never a person's browser.
 *
 *   node scripts/clean-sessions.mjs            # report only, changes nothing
 *   node scripts/clean-sessions.mjs --apply    # delete what the report lists
 *
 * Connects with ADMIN_DATABASE_URL (or AUTH_DATABASE_URL when GoTrue has its
 * own database). Two kinds of row go:
 *
 *  - Sessions opened by the server re-checking a password ("node", "undici"
 *    user agents). Before this batch the password and email routes signed in on
 *    the server to check the current password, and each check left a session.
 *  - Sessions whose user agent was overwritten by the middleware's token
 *    refresh ("Next.js Middleware") AND that nobody has used for a week. A
 *    recently used one is a real browser that will show its own name after
 *    the next refresh, so it stays: signing out a person mid-task is worse
 *    than a stale label.
 *
 * GoTrue keeps one row per session, never one per request, so there are no
 * per-token duplicates to collapse; the "nine rows" were nine sessions.
 * Deleting a session also deletes its refresh tokens (foreign key cascade).
 */
import { PrismaClient } from "../packages/prisma/src/generated/client/index.js";

const url = process.env.AUTH_DATABASE_URL || process.env.ADMIN_DATABASE_URL;
if (!url) {
  console.error("Set ADMIN_DATABASE_URL (or AUTH_DATABASE_URL).");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const db = new PrismaClient({ datasources: { db: { url } } });
const query = async (sql) => ({ rows: await db.$queryRawUnsafe(sql) });

const STALE = `coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at) < now() - interval '7 days'`;
const SERVER_UA = `(s.user_agent IS NULL OR s.user_agent ~* '^(node|undici)' )`;
const MIDDLEWARE_UA = `s.user_agent = 'Next.js Middleware'`;
const where = `(${SERVER_UA}) OR (${MIDDLEWARE_UA} AND ${STALE})`;

const total = await query(`SELECT count(*)::int AS n, pg_size_pretty(pg_total_relation_size('auth.sessions')) AS size FROM auth.sessions`);
const byAgent = await query(`
  SELECT coalesce(s.user_agent, '(none)') AS agent, count(*)::int AS n
  FROM auth.sessions s GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
const doomed = await query(`SELECT count(*)::int AS n FROM auth.sessions s WHERE ${where}`);

console.log(`auth.sessions: ${total.rows[0].n} rows, ${total.rows[0].size} on disk`);
console.table(byAgent.rows);
console.log(`${doomed.rows[0].n} rows were never a browser session, or are middleware-labelled and unused for 7 days.`);

if (apply) {
  const n = await db.$executeRawUnsafe(`DELETE FROM auth.sessions s WHERE ${where}`);
  console.log(`Deleted ${n}.`);
} else {
  console.log("Nothing changed. Run again with --apply to delete them.");
}
await db.$disconnect();
