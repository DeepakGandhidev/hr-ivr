import { PrismaClient } from './generated/client/index.js';

const globalForPrisma = globalThis;

const logLevels = process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'];

/**
 * Request-path client. In deployment this connects as a NOSUPERUSER role so the
 * row-level security policies actually bind — a superuser bypasses RLS even
 * when the table is set to FORCE ROW LEVEL SECURITY.
 */
export const prisma = globalForPrisma.__prisma ?? new PrismaClient({ log: logLevels });

/**
 * Bootstrap-only client, used to answer "who is this session, and which tenant
 * do they belong to?" — a question that cannot be asked from inside a tenant
 * context, because resolving the tenant is the point of asking it.
 *
 * Everything else must go through withTenant(). Widen the use of this client
 * only with the same care you would widen a security boundary, because that is
 * what it is: queries made here are not filtered by RLS.
 */
export const adminPrisma = globalForPrisma.__adminPrisma ?? new PrismaClient({
  log: logLevels,
  ...(process.env.ADMIN_DATABASE_URL
    ? { datasources: { db: { url: process.env.ADMIN_DATABASE_URL } } }
    : {}),
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
  globalForPrisma.__adminPrisma = adminPrisma;
}

/**
 * Run a callback inside a transaction that sets the Postgres `app.current_tenant`
 * setting, so the row-level security policies scope every query to one tenant.
 *
 * set_config() is used with a bound parameter rather than string interpolation:
 * the tenant id reaches this function from a lookup rather than from a request
 * body, but a SET built by concatenation is one refactor away from being an
 * injection point, and this one sits on the tenant-isolation boundary.
 */
export async function withTenant(tenantId, cb) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return cb(tx);
  });
}

export { PrismaClient };
