/**
 * Wipe every tenant's data so the instance can be handed to real users.
 *
 * Keeps: the `plans` table, which is reference data the signup flow reads, not
 * demo content — a tenant cannot be created without a plan to attach to.
 *
 * Removes: all tenants and everything that cascades from them (users, jobs,
 * candidates, screenings, shortlists, interview calls, email connections), plus
 * the matching Supabase auth accounts. Deleting the app-side user but leaving
 * the auth account behind would make that email permanently un-registerable:
 * signup would fail with "already registered" while the workspace no longer
 * exists.
 *
 *   node scripts/reset-production.mjs --confirm
 *
 * Without --confirm it only reports what it would delete.
 */
import 'dotenv/config';
import { PrismaClient } from '@pratibha/prisma';

const prisma = new PrismaClient();
const confirmed = process.argv.includes('--confirm');

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function purgeSupabaseUsers(emails) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.log('  ! SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — auth accounts left in place.');
    console.log('    Those email addresses will not be able to sign up again until removed.');
    return;
  }

  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers });
  if (!res.ok) {
    console.log(`  ! Could not list auth users (${res.status}); left in place.`);
    return;
  }

  const { users = [] } = await res.json();
  const wanted = new Set(emails.map((e) => e.toLowerCase()));
  const targets = users.filter((u) => u.email && wanted.has(u.email.toLowerCase()));

  for (const user of targets) {
    const del = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: 'DELETE',
      headers,
    });
    console.log(`  ${del.ok ? '-' : '!'} auth account ${user.email}${del.ok ? '' : ` (failed: ${del.status})`}`);
  }

  if (targets.length === 0) console.log('  (no matching auth accounts)');
}

async function main() {
  const [tenants, users, jobs, candidates, connections, plans] = await Promise.all([
    prisma.tenant.findMany({ select: { id: true, name: true, slug: true } }),
    prisma.user.findMany({ select: { email: true } }),
    prisma.job.count(),
    prisma.candidate.count(),
    prisma.emailConnection.count(),
    prisma.plan.count(),
  ]);

  console.log('\nCurrent contents');
  console.log('----------------');
  for (const t of tenants) console.log(`  tenant  ${t.slug.padEnd(12)} ${t.name}`);
  console.log(`  users ${users.length} · jobs ${jobs} · candidates ${candidates} · mailboxes ${connections}`);
  console.log(`  plans ${plans} (kept — reference data, not demo content)\n`);

  if (tenants.length === 0) {
    console.log('Nothing to remove; already clean.\n');
    return;
  }

  if (!confirmed) {
    console.log('DRY RUN. Nothing was deleted.');
    console.log('Re-run with --confirm to delete everything above except plans.\n');
    return;
  }

  console.log('Deleting:');
  const emails = users.map((u) => u.email).filter(Boolean);

  /**
   * Deleting tenants alone does not work, even though most rows cascade from
   * them. Four foreign keys are RESTRICT rather than CASCADE:
   *
   *   outreach_emails.approval_id  -> approvals
   *   outreach_emails.template_id  -> outreach_templates
   *   approvals.approved_by        -> users
   *   jobs.created_by              -> users
   *
   * The last two are the ones that bite: a tenant cascade tries to remove
   * users and jobs together, and Postgres will not drop a user while a job
   * still records them as its creator. So the order is explicit, children
   * first. Each step is a no-op when that table is already empty.
   */
  const order = [
    ['outreachEmail', () => prisma.outreachEmail.deleteMany({})],
    ['assessmentReport', () => prisma.assessmentReport.deleteMany({})],
    ['interviewCall', () => prisma.interviewCall.deleteMany({})],
    ['approval', () => prisma.approval.deleteMany({})],
    ['shortlistItem', () => prisma.shortlistItem.deleteMany({})],
    ['shortlist', () => prisma.shortlist.deleteMany({})],
    ['screening', () => prisma.screening.deleteMany({})],
    ['candidate', () => prisma.candidate.deleteMany({})],
    ['jobPost', () => prisma.jobPost.deleteMany({})],
    ['jobDescription', () => prisma.jobDescription.deleteMany({})],
    ['callWindow', () => prisma.callWindow.deleteMany({})],
    ['interviewProtocol', () => prisma.interviewProtocol.deleteMany({})],
    ['emailConnection', () => prisma.emailConnection.deleteMany({})],
    ['job', () => prisma.job.deleteMany({})],
    ['outreachTemplate', () => prisma.outreachTemplate.deleteMany({})],
    ['usageMeter', () => prisma.usageMeter.deleteMany({})],
    ['auditLog', () => prisma.auditLog.deleteMany({})],
    ['user', () => prisma.user.deleteMany({})],
    ['tenant', () => prisma.tenant.deleteMany({})],
  ];

  for (const [name, run] of order) {
    const { count } = await run();
    if (count > 0) console.log(`  - ${String(count).padStart(4)} ${name}`);
  }

  await purgeSupabaseUsers(emails);

  const [jobsLeft, candidatesLeft, connectionsLeft, plansLeft] = await Promise.all([
    prisma.job.count(),
    prisma.candidate.count(),
    prisma.emailConnection.count(),
    prisma.plan.count(),
  ]);

  console.log('\nAfter reset');
  console.log('-----------');
  console.log(`  jobs ${jobsLeft} · candidates ${candidatesLeft} · mailboxes ${connectionsLeft}`);
  console.log(`  plans ${plansLeft} (intact)`);
  console.log('\nDone. Sign up at /signup to create the first real workspace.\n');
}

main()
  .catch((err) => {
    console.error('Reset failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
