import { adminPrisma } from "@pratibha/prisma";

/**
 * A connection that can read GoTrue's `auth` schema.
 *
 * In production GoTrue shares the application database, so this is simply the
 * admin client. Local development runs GoTrue in its own Supabase database;
 * AUTH_DATABASE_URL points there when set.
 */
const globalForAuth = globalThis as unknown as { __authDb?: typeof adminPrisma };

export const authDb: typeof adminPrisma = process.env.AUTH_DATABASE_URL
  ? (globalForAuth.__authDb ??= new (adminPrisma.constructor as new (o: unknown) => typeof adminPrisma)({
      datasources: { db: { url: process.env.AUTH_DATABASE_URL } },
    }))
  : adminPrisma;
