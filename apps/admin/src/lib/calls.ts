import type { AdminUser } from "@pratibha/prisma";
import { db } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import { badRequest, conflict, notFound } from "@/lib/http";

/**
 * The line across every workspace: strays the worker could not match, the
 * numbers blocked at the line, and a search across every workspace by number.
 */

/** India-first E.164, the form candidates and blocks are stored in. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  const bare = digits.replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(bare)) return null;
  if (bare.length === 10) return `+91${bare}`;
  if (bare.length === 12 && bare.startsWith("91")) return `+${bare}`;
  return digits.startsWith("+") ? digits : `+${bare}`;
}

/** "+91 98110 44873". */
export function displayPhone(e164: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

export async function strays(sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const rows = await db.unknownCall.findMany({ where: { at: { gte: since } }, orderBy: { at: "desc" } });
  const blocks = await db.blockedNumber.findMany({ where: { unblockedAt: null } });
  const tenants = await db.tenant.findMany({
    where: { id: { in: Array.from(new Set(rows.map((r) => r.tenantId).filter((x): x is string => Boolean(x)))) } },
    select: { id: true, name: true },
  });

  const byNumber = new Map<string, { number: string; latest: (typeof rows)[number]; tries: number }>();
  for (const r of rows) {
    const e = byNumber.get(r.callerNumber);
    if (e) e.tries += 1;
    else byNumber.set(r.callerNumber, { number: r.callerNumber, latest: r, tries: 1 });
  }
  return Array.from(byNumber.values()).map((e) => ({
    number: e.number,
    at: e.latest.at,
    tries: e.tries,
    reason: e.latest.reason,
    reasonCode: e.latest.reasonCode,
    tenant: tenants.find((t) => t.id === e.latest.tenantId) ?? null,
    blocked: blocks.some((b) => b.phoneE164 === e.number),
  }));
}

export async function blockNumber(admin: AdminUser, raw: string, reason: string) {
  const phone = normalizePhone(raw);
  if (!phone) throw badRequest("That is not a phone number.");
  const existing = await db.blockedNumber.findFirst({ where: { phoneE164: phone, unblockedAt: null } });
  if (existing) throw conflict(`${displayPhone(phone)} is already blocked.`);

  // A block that would silence a real candidate is worth a second look.
  const candidates = await db.candidate.count({ where: { phoneE164: phone } });

  await db.$transaction(async (tx) => {
    await tx.blockedNumber.create({ data: { phoneE164: phone, reason, blockedBy: admin.id } });
    await recordActivity(
      {
        actor: admin,
        action: "calls.number_blocked",
        summary: `${admin.name} blocked ${displayPhone(phone)} at the line`,
        reason,
        after: { phone, matchingCandidates: candidates },
      },
      tx
    );
  });
  return {
    message: `${displayPhone(phone)} is blocked. Its next call is refused before the agent answers.${candidates ? ` Note: ${candidates} candidate record${candidates === 1 ? " uses" : "s use"} this number.` : ""}`,
  };
}

export async function unblockNumber(admin: AdminUser, raw: string, reason: string) {
  const phone = normalizePhone(raw);
  if (!phone) throw badRequest("That is not a phone number.");
  const block = await db.blockedNumber.findFirst({ where: { phoneE164: phone, unblockedAt: null } });
  if (!block) throw notFound(`${displayPhone(phone)} is not blocked.`);
  await db.$transaction(async (tx) => {
    await tx.blockedNumber.update({ where: { id: block.id }, data: { unblockedAt: new Date(), unblockedBy: admin.id } });
    await recordActivity(
      { actor: admin, action: "calls.number_unblocked", summary: `${admin.name} unblocked ${displayPhone(phone)}`, reason, before: { phone, hits: block.hits } },
      tx
    );
  });
  return { message: `${displayPhone(phone)} can call again.` };
}

/** Every candidate in every workspace with this number, so a typo in an invite can be found. */
export async function findCandidates(raw: string) {
  const phone = normalizePhone(raw);
  if (!phone) throw badRequest("That is not a phone number.");
  const last10 = phone.slice(-10);
  const rows = await db.candidate.findMany({
    where: { OR: [{ phoneE164: phone }, { phoneE164: { endsWith: last10 } }] },
    include: { tenant: { select: { id: true, name: true } }, job: { select: { title: true } } },
    take: 20,
  });
  return rows.map((c) => ({
    candidateId: c.id,
    name: c.name ?? "Unnamed candidate",
    email: c.email,
    status: c.status,
    job: c.job.title,
    tenantId: c.tenant.id,
    tenantName: c.tenant.name,
  }));
}

export async function lineHealth() {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [dropped, calls, hindi, blocks] = await Promise.all([
    db.interviewCall.count({ where: { startedAt: { gte: weekAgo }, status: "dropped" } }),
    db.interviewCall.count({ where: { startedAt: { gte: weekAgo }, language: { not: null } } }),
    db.interviewCall.count({ where: { startedAt: { gte: weekAgo }, language: { in: ["hi", "hinglish"] } } }),
    db.blockedNumber.findMany({ where: { unblockedAt: null }, orderBy: { createdAt: "desc" } }),
  ]);
  return { dropped, hindiShare: calls ? Math.round((hindi / calls) * 100) : null, blocks };
}
