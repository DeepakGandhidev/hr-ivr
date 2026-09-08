/**
 * Make one phone number call-ready, end to end.
 *
 * Caller recognition (§5 Stage 8) only accepts a number that belongs to a
 * candidate who is on a shortlist AND inside an approval snapshot — the human
 * gate from §2.2. Creating a candidate row alone is not enough: Pratibha will
 * treat them as an unknown caller and refuse the interview. This script does
 * the whole chain so you can ring in and be recognised.
 *
 *   node scripts/add-test-candidate.js +919876543210 "Your Name" you@example.com
 *
 * Re-running is safe: it refreshes the candidate and clears prior calls, so the
 * same number can be interviewed again instead of hitting the
 * "already interviewed" path.
 */
import { PrismaClient } from '@pratibha/prisma';

const prisma = new PrismaClient();

const [rawPhone, rawName, rawEmail] = process.argv.slice(2);
const JOB_ID = process.env.TEST_JOB_ID ?? 'job-mock-backend';

function normalisePhone(raw) {
  const s = String(raw ?? '').trim();
  const digits = s.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (s.startsWith('+')) return `+${digits}`;
  // Bare 10-digit Indian mobile.
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

async function main() {
  const phoneE164 = normalisePhone(rawPhone);
  if (!phoneE164) {
    console.error('Usage: node scripts/add-test-candidate.js <phone> ["Name"] [email]');
    console.error('   e.g. node scripts/add-test-candidate.js +919876543210 "Deepak" deepak@promonkey.tech');
    process.exit(1);
  }

  const name = rawName || 'Test Candidate';
  const email = rawEmail || `test.${phoneE164.replace(/\D/g, '')}@example.com`;

  const job = await prisma.job.findUnique({ where: { id: JOB_ID }, include: { tenant: true } });
  if (!job) {
    console.error(`Job ${JOB_ID} not found. Run: npm run db:mock`);
    process.exit(1);
  }

  // 1. Candidate. Keyed on (tenant, job, phone) — the same uniqueness the
  //    caller-recognition lookup relies on.
  const existing = await prisma.candidate.findFirst({
    where: { tenantId: job.tenantId, jobId: job.id, phoneE164 },
  });

  const cvParsed = {
    name,
    email,
    phone: phoneE164,
    experience: '6 years',
    skills: ['Node.js', 'PostgreSQL', 'API design', 'Redis', 'AWS'],
    education: 'B.Tech Computer Science',
    employers: ['Northline Systems', 'Craftbase'],
  };

  const candidate = existing
    ? await prisma.candidate.update({
        where: { id: existing.id },
        data: { name, email, cvParsed, parseFailed: false, noPhone: false },
      })
    : await prisma.candidate.create({
        data: {
          tenantId: job.tenantId,
          jobId: job.id,
          name,
          email,
          phoneE164,
          cvParsed,
          sourceEmailMsgId: `<test-${Date.now()}@mail.local>`,
        },
      });

  // 2. Screening, so the candidates screen shows a score rather than a blank.
  const screening = await prisma.screening.findFirst({ where: { candidateId: candidate.id } });
  if (!screening) {
    await prisma.screening.create({
      data: {
        candidateId: candidate.id,
        score: 88,
        matchedMustHaves: ['Node.js', 'API design', 'PostgreSQL'],
        gaps: [],
        model: 'seed',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        verdict: 'shortlist',
        reasonSummary: 'Seeded test candidate — covers every must-have for this role.',
      },
    });
  }

  // 3. Shortlist membership.
  let shortlist = await prisma.shortlist.findFirst({
    where: { jobId: job.id },
    orderBy: { createdAt: 'desc' },
  });
  if (!shortlist) {
    shortlist = await prisma.shortlist.create({ data: { jobId: job.id, status: 'approved' } });
  }

  await prisma.shortlistItem.upsert({
    where: { shortlistId_candidateId: { shortlistId: shortlist.id, candidateId: candidate.id } },
    update: { finalState: 'approved', removedBy: null },
    create: {
      shortlistId: shortlist.id,
      candidateId: candidate.id,
      addedBy: 'ai',
      finalState: 'approved',
    },
  });

  // 4. The approval snapshot. This is the artifact the call path actually
  //    checks, so the candidate has to be written into it.
  const owner = await prisma.user.findFirst({ where: { tenantId: job.tenantId, role: 'owner' } });
  const approval = await prisma.approval.findFirst({
    where: { shortlistId: shortlist.id },
    orderBy: { approvedAt: 'desc' },
  });

  const entry = {
    candidateId: candidate.id,
    name: candidate.name,
    email: candidate.email,
    phoneE164: candidate.phoneE164,
  };

  if (approval) {
    const snapshot = Array.isArray(approval.snapshot) ? approval.snapshot : [];
    const without = snapshot.filter((s) => s?.candidateId !== candidate.id);
    await prisma.approval.update({
      where: { id: approval.id },
      data: { snapshot: [...without, entry] },
    });
  } else {
    await prisma.approval.create({
      data: {
        shortlistId: shortlist.id,
        approvedBy: owner.id,
        approvedAt: new Date(),
        snapshot: [entry],
      },
    });
  }

  await prisma.shortlist.update({ where: { id: shortlist.id }, data: { status: 'approved' } });

  // 5. Clear earlier calls so this number is interviewable again rather than
  //    being short-circuited by the repeat-caller path.
  const priorCalls = await prisma.interviewCall.findMany({
    where: { candidateId: candidate.id },
    select: { id: true },
  });
  if (priorCalls.length) {
    const ids = priorCalls.map((c) => c.id);
    await prisma.assessmentReport.deleteMany({ where: { interviewCallId: { in: ids } } });
    await prisma.interviewCall.deleteMany({ where: { id: { in: ids } } });
  }

  console.log('\nCall-ready.\n');
  console.log(`  Candidate : ${candidate.name}  <${candidate.email}>`);
  console.log(`  Phone     : ${candidate.phoneE164}   <- ring in from exactly this number`);
  console.log(`  Role      : ${job.title} @ ${job.tenant.name}`);
  console.log(`  Approved  : yes (in approval snapshot)`);
  console.log(`  Prior calls cleared: ${priorCalls.length}`);
  console.log(`\nSimulate the call now:`);
  console.log(`  npm run simulate -w @pratibha/worker -- ${candidate.phoneE164} normal\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
