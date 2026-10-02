import { PLANS, TRIAL_DAYS, TRIAL_LIMITS } from "@pratibha/shared";
import { adminPrisma, type Plan, type TopupPack, type TrialConfig } from "@pratibha/prisma";

/**
 * Published pricing, read from the database.
 *
 * The admin panel's Plans and pricing page is the one table of truth: a
 * workspace's plan is the exact plan version row it points at (so a price
 * change grandfathers it), and what is on sale is the newest published version
 * of each plan, the newest published trial and the published packs. Publishing
 * is one transaction, so every reader here switches at the same instant.
 *
 * These tables are platform-wide reference data with no tenant rows, readable
 * by the portal's role and writable only by the admin panel's.
 *
 * The constants in @pratibha/shared remain only as a fallback for a database
 * that has not been migrated, so a missing row degrades to the old behaviour
 * instead of an error page.
 */

type Db = Pick<typeof adminPrisma, "plan" | "trialConfig" | "topupPack">;

export const PLAN_ORDER = ["starter", "growth", "scale"];

/** Newest published version of each plan, cheapest first. Hidden plans included unless asked. */
export async function currentPlans(db: Db = adminPrisma, opts: { publicOnly?: boolean } = {}): Promise<Plan[]> {
  const rows = await db.plan.findMany({
    where: { status: "published" },
    orderBy: [{ key: "asc" }, { version: "desc" }],
  });
  const latest = new Map<string, Plan>();
  for (const p of rows) if (!latest.has(p.key)) latest.set(p.key, p);
  return Array.from(latest.values())
    .filter((p) => !opts.publicOnly || p.visibility === "public")
    .sort((a, b) => {
      const ia = PLAN_ORDER.indexOf(a.key);
      const ib = PLAN_ORDER.indexOf(b.key);
      return ia !== ib ? (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) : a.priceInr - b.priceInr;
    });
}

export async function currentPlan(key: string, db: Db = adminPrisma): Promise<Plan | null> {
  return db.plan.findFirst({ where: { key, status: "published" }, orderBy: { version: "desc" } });
}

export async function currentTrial(db: Db = adminPrisma): Promise<TrialConfig | null> {
  return db.trialConfig.findFirst({ where: { status: "published" }, orderBy: { publishedAt: "desc" } });
}

export async function livePacks(db: Db = adminPrisma): Promise<TopupPack[]> {
  const packs = await db.topupPack.findMany({ where: { status: "published" } });
  return packs.sort((a, b) => (a.kind === b.kind ? a.quantity - b.quantity : a.kind === "minutes" ? -1 : 1));
}

/** Trial allowances, from the live trial with the old constants behind them. */
export function trialAllowance(trial: TrialConfig | null) {
  return {
    days: trial?.days ?? TRIAL_DAYS,
    minutes: trial?.minutes ?? TRIAL_LIMITS.interviewMinutes,
    screenings: trial?.screenings ?? TRIAL_LIMITS.screenings,
    jobs: trial?.jobLimit ?? TRIAL_LIMITS.jobs,
  };
}

/** A plan row's allowances, falling back to the constant of the same key if the row predates the columns. */
export function planAllowance(plan: Pick<Plan, "key" | "minutes" | "screenings" | "jobLimit"> | null | undefined, planId?: string) {
  if (plan && typeof plan.minutes === "number") {
    return { minutes: plan.minutes, screenings: plan.screenings, jobs: plan.jobLimit };
  }
  const constant = PLANS[(plan?.key ?? planId) as keyof typeof PLANS];
  if (!constant) return null;
  return {
    minutes: constant.limits.interviewMinutes,
    screenings: constant.limits.screenings,
    jobs: constant.limits.roles,
  };
}

/** The shape every pricing surface serves: the website, the portal and Saarthi. */
export function publicPlan(p: Plan) {
  return {
    key: p.key,
    name: p.name,
    version: p.version,
    priceInr: p.priceInr,
    // Display only. Never charged or invoiced.
    slashedPriceInr: p.slashedPriceInr,
    minutes: p.minutes,
    screenings: p.screenings,
    jobLimit: p.jobLimit,
    publishedAt: p.publishedAt,
  };
}

export function publicPack(p: TopupPack) {
  return { id: p.id, kind: p.kind, quantity: p.quantity, priceInr: p.priceInr, validityDays: p.validityDays };
}
