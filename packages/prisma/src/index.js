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

/** How long one request-path transaction may run before Postgres gives up on it. */
const TRANSACTION_TIMEOUT_MS = Number(process.env.PRISMA_TRANSACTION_TIMEOUT_MS) || 20_000;

/** How long to wait for a free connection before failing fast. */
const TRANSACTION_MAX_WAIT_MS = Number(process.env.PRISMA_TRANSACTION_MAX_WAIT_MS) || 5_000;

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
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return cb(tx);
    },
    // Prisma's default interactive-transaction timeout is 5s, and production
    // has already thrown P2028 at 5530ms. The tenant setting is transaction-
    // local, so every request-path read has to live inside one of these - and
    // queries in an interactive transaction share a single connection, which
    // means a Promise.all inside it does not run in parallel, it queues. A
    // read assembling a page from a dozen queries therefore pays a dozen
    // serialised round trips and brushes the ceiling on a small box.
    //
    // Raised rather than removed: an unbounded transaction holds a connection
    // until the pool starves, which is a worse failure than a slow page.
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS }
  );
}

export { PrismaClient };

/**
 * The Prisma namespace, for callers needing its sentinels and enums at runtime
 * (`Prisma.DbNull`, `Prisma.JsonNull`).
 *
 * The type declaration next door has always re-exported everything from the
 * generated client, so `import { Prisma }` type-checked here while resolving to
 * undefined at runtime - a mismatch that fails only when the value is actually
 * used, which for a sentinel means a silently wrong query rather than an error.
 */
export { Prisma } from './generated/client/index.js';
