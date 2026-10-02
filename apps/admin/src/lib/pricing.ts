import type { Plan, TopupPack, TrialConfig } from "@pratibha/prisma";
import { AVERAGE_INTERVIEW_MINUTES } from "@pratibha/shared";
import { db, type Db } from "@/lib/db";

/**
 * What is live: the newest published version of each plan, the newest
 * published trial, and the published packs. The website, the portal and
 * Saarthi read exactly these (via the portal's public pricing endpoint), so
 * this module and that endpoint must agree on the definition.
 */
export const PLAN_ORDER = ["starter", "growth", "scale"] as const;

export function sortPlans<T extends { key: string; priceInr: number }>(plans: T[]): T[] {
  return [...plans].sort((a, b) => {
    const ia = PLAN_ORDER.indexOf(a.key as (typeof PLAN_ORDER)[number]);
    const ib = PLAN_ORDER.indexOf(b.key as (typeof PLAN_ORDER)[number]);
    if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.priceInr - b.priceInr;
  });
}

export async function currentPlans(client: Db = db): Promise<Plan[]> {
  const published = await client.plan.findMany({
    where: { status: "published" },
    orderBy: [{ key: "asc" }, { version: "desc" }],
  });
  const latest = new Map<string, Plan>();
  for (const p of published) if (!latest.has(p.key)) latest.set(p.key, p);
  return sortPlans([...latest.values()]);
}

export async function currentPlan(key: string, client: Db = db): Promise<Plan | null> {
  return client.plan.findFirst({ where: { key, status: "published" }, orderBy: { version: "desc" } });
}

export async function currentTrial(client: Db = db): Promise<TrialConfig | null> {
  return client.trialConfig.findFirst({ where: { status: "published" }, orderBy: { publishedAt: "desc" } });
}

export async function livePacks(client: Db = db): Promise<TopupPack[]> {
  const packs = await client.topupPack.findMany({ where: { status: "published" } });
  return packs.sort((a, b) => (a.kind === b.kind ? a.quantity - b.quantity : a.kind === "minutes" ? -1 : 1));
}

export function packLabel(p: Pick<TopupPack, "kind" | "quantity">): string {
  return `${p.quantity.toLocaleString("en-IN")} ${p.kind === "minutes" ? "minutes" : "CV screenings"}`;
}

/** The limits a plan row grants, with the jsonb the worker reads kept in step. */
export function limitsJson(p: Pick<Plan, "minutes" | "screenings" | "jobLimit">, previous: unknown = {}) {
  const prev = (previous ?? {}) as Record<string, unknown>;
  return {
    ...prev,
    interviewMinutes: p.minutes,
    screenings: p.screenings,
    roles: p.jobLimit,
    // Customers think in interviews; described at the average interview length.
    interviews: Math.floor(p.minutes / AVERAGE_INTERVIEW_MINUTES),
  };
}
