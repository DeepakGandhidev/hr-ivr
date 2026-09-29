/**
 * One-time cleanup of role titles, locations and JD text (change request J70).
 *
 *   - "Human Resoruce Manager"          -> "Human Resource Manager"
 *   - every "Gurgoan Office Promonkey"  -> "Gurugram office"
 *     style location variant
 *   - "Gurgoan" inside JD bodies        -> "Gurugram", as a new JD version,
 *     approved and republished when the version it corrects was, because
 *     Pratibha speaks the JD on calls and the public page shows it.
 *
 * Dry run by default: it prints what it would change and writes nothing.
 *
 *   ADMIN_DATABASE_URL=postgres://... \
 *     node scripts/cleanup-job-data.mjs --tenant promonkey --as gaurav@promonkey.tech
 *   ...same... --apply
 *
 * --as names the workspace user the changes are recorded under (job version
 * author, JD approver, audit actor). Needs the owner connection: it reads
 * outside any tenant context.
 */
import { PrismaClient } from '@pratibha/prisma';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};
const tenantSlug = flag('--tenant');
const actorEmail = flag('--as');
const apply = args.includes('--apply');

if (!tenantSlug || !actorEmail) {
  console.error('Usage: node scripts/cleanup-job-data.mjs --tenant <slug> --as <user email> [--apply]');
  process.exit(1);
}

const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
const db = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);

const TITLE_FIXES = [[/\bResoruce\b/g, 'Resource']];

/** Any spelling of Gurgaon, as typed into these fields. */
const GURGAON = /\bgurg(?:oan|aon|on|oun|ao)\b/gi;

function fixTitle(title) {
  return TITLE_FIXES.reduce((t, [re, to]) => t.replace(re, to), title);
}

function fixLocation(location) {
  if (!location) return location;
  GURGAON.lastIndex = 0;
  if (!GURGAON.test(location)) return location;
  // "Gurgoan Office Promonkey", "Gurgaon office, ProMonkey", "Promonkey Gurgoan office"...
  if (/office|promonkey/i.test(location)) return 'Gurugram office';
  return location.replace(GURGAON, 'Gurugram');
}

function fixBody(body) {
  return fixTitle(body).replace(/\bGurgoan\b/g, 'Gurugram').replace(/\bGURGOAN\b/g, 'GURUGRAM');
}

async function main() {
  const tenant = await db.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) throw new Error(`No workspace with slug "${tenantSlug}"`);
  const actor = await db.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: actorEmail } } });
  if (!actor) throw new Error(`${actorEmail} is not a user in ${tenantSlug}`);

  const jobs = await db.job.findMany({
    where: { tenantId: tenant.id },
    include: {
      descriptions: { orderBy: { version: 'desc' }, take: 1 },
      versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true } },
      posts: { where: { channel: 'careers_page', status: 'posted' }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
  });

  let changed = 0;

  for (const job of jobs) {
    const title = fixTitle(job.title);
    const location = fixLocation(job.location);
    const jd = job.descriptions[0] ?? null;
    const body = jd ? fixBody(jd.bodyMd) : null;

    const titleChanged = title !== job.title;
    const locationChanged = location !== job.location;
    const bodyChanged = Boolean(jd && body !== jd.bodyMd);
    if (!titleChanged && !locationChanged && !bodyChanged) continue;

    changed += 1;
    const republish = bodyChanged && Boolean(jd.approvedAt) && job.posts.length > 0 && !job.deletedAt;
    console.log(`\n${job.title}${job.deletedAt ? ' (archived)' : ''}`);
    if (titleChanged) console.log(`  title:    "${job.title}" -> "${title}"`);
    if (locationChanged) console.log(`  location: "${job.location}" -> "${location}"`);
    if (bodyChanged) {
      console.log(`  JD:       version ${jd.version} -> ${jd.version + 1} (spelling only)` +
        `${jd.approvedAt ? ', approved' : ', left for approval'}${republish ? ', republished' : ''}`);
    }
    if (!apply) continue;

    await db.$transaction(async (tx) => {
      if (titleChanged || locationChanged) {
        // Snapshot first, as every edit through the portal does, so the
        // history still says what candidates were screened against.
        await tx.jobVersion.create({
          data: {
            jobId: job.id,
            version: (job.versions[0]?.version ?? 0) + 1,
            title: job.title,
            location: job.location,
            salaryBand: job.salaryBand,
            experienceRange: job.experienceRange,
            mustHaves: job.mustHaves,
            goodToHaves: job.goodToHaves,
            screeningThreshold: job.screeningThreshold,
            changeNote: 'Data cleanup: corrected spelling of the title or location',
            createdBy: actor.id,
          },
        });
        await tx.job.update({ where: { id: job.id }, data: { title, location } });
      }

      if (bodyChanged) {
        const now = new Date();
        const next = await tx.jobDescription.create({
          data: {
            jobId: job.id,
            version: jd.version + 1,
            bodyMd: body,
            generatedBy: 'human',
            ...(jd.approvedAt ? { approvedBy: actor.id, approvedAt: now } : {}),
          },
        });
        if (republish) {
          await tx.jobPost.update({
            where: { id: job.posts[0].id },
            data: { postedAt: now, externalRef: next.id },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          actor: actor.id,
          action: 'job.data_cleanup',
          entity: 'job',
          entityId: job.id,
          before: { title: job.title, location: job.location, jdVersion: jd?.version ?? null },
          after: { title, location, jdVersion: bodyChanged ? jd.version + 1 : jd?.version ?? null, republished: republish },
          reason: 'J70 one-time cleanup of role titles, locations and JD spelling',
        },
      });
    });
  }

  console.log(
    changed === 0
      ? '\nNothing to change.'
      : apply
        ? `\nUpdated ${changed} ${changed === 1 ? 'role' : 'roles'}.`
        : `\nDry run: ${changed} ${changed === 1 ? 'role' : 'roles'} would change. Re-run with --apply to write.`
  );
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
