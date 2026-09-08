/**
 * Creates local Supabase Auth users for the mock team and links each one to its
 * row in `users.auth_provider_id`.
 *
 * The seed data alone cannot log in: loadTenantContext() resolves a request by
 * matching the Supabase session's user id against users.auth_provider_id, so
 * without this every tenant screen 401s and only the public careers page is
 * reachable. Local Supabase only — it refuses to run against a remote project.
 *
 *   node scripts/seed-mock-auth.js
 */
import { PrismaClient } from '@pratibha/prisma';

const prisma = new PrismaClient();

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.MOCK_USER_PASSWORD ?? 'pratibha123';

// Refuse to create password users with a shared, published password anywhere
// but a local stack.
if (!/(127\.0\.0\.1|localhost)/.test(SUPABASE_URL)) {
  console.error(`Refusing to seed mock auth users against a non-local Supabase (${SUPABASE_URL}).`);
  process.exit(1);
}

if (!SERVICE_ROLE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.');
  process.exit(1);
}

async function admin(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const users = await prisma.user.findMany({
    where: { tenant: { slug: { in: ['acme', 'globex'] } } },
    include: { tenant: { select: { slug: true } } },
    orderBy: { email: 'asc' },
  });

  if (!users.length) {
    console.error('No mock users found. Run: npm run db:mock');
    process.exit(1);
  }

  const existing = await admin('/users?per_page=200');
  const byEmail = new Map((existing.users ?? []).map((u) => [u.email?.toLowerCase(), u]));

  for (const user of users) {
    const email = user.email.toLowerCase();
    let authUser = byEmail.get(email);

    if (authUser) {
      // Reset the password so a re-run always leaves a known-good login.
      await admin(`/users/${authUser.id}`, {
        method: 'PUT',
        body: JSON.stringify({ password: PASSWORD, email_confirm: true }),
      });
    } else {
      authUser = await admin('/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password: PASSWORD,
          email_confirm: true,
          user_metadata: { name: user.name },
        }),
      });
    }

    if (user.authProviderId !== authUser.id) {
      await prisma.user.update({
        where: { id: user.id },
        data: { authProviderId: authUser.id },
      });
    }

    console.log(`  ${email.padEnd(24)} ${user.role.padEnd(9)} /${user.tenant.slug}`);
  }

  console.log(`\nAll mock users share the password: ${PASSWORD}`);
  console.log('Sign in at http://localhost:3000/login');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
