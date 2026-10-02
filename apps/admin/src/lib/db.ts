import { PrismaClient } from "@pratibha/prisma";

/**
 * The admin panel's one database client.
 *
 * Connects as its own role (ADMIN_APP_DATABASE_URL → pratibha_admin): BYPASSRLS,
 * because every page here reads across workspaces, but never a superuser, and
 * without UPDATE or DELETE on activity_log. It is deliberately not the portal's
 * connection: the portal's role cannot read a single admin table, and this app
 * never borrows the portal's credentials.
 */
const globalForDb = globalThis as unknown as { __adminDb?: PrismaClient };

const url = process.env.ADMIN_APP_DATABASE_URL ?? process.env.DATABASE_URL;

export const db: PrismaClient =
  globalForDb.__adminDb ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    ...(url ? { datasources: { db: { url } } } : {}),
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__adminDb = db;
}

/** A transaction handle, for helpers that must run inside one. */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Either the client or a transaction: helpers that work in both take this. */
export type Db = PrismaClient | Tx;
