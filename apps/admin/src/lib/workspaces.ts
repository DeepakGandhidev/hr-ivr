import type { Prisma, Plan, TenantStatus, TrialConfig } from "@pratibha/prisma";
import { db, type Db } from "@/lib/db";
import { currentTrial } from "@/lib/pricing";

/**
 * One definition of each workspace figure, used by the list, the detail page
 * and the dashboard alike, so a number cannot mean one thing in one place and
 * another somewhere else.
 */

/** The meter period, as the worker writes it: the UTC calendar month. */
export function usagePeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Statuses that count as a paying customer. */
export const PAYING: TenantStatus[] = ["active", "past_due"];

/** Shown in the list. `deleted` (erased) workspaces are not. */
export const LISTED: TenantStatus[] = ["trial", "active", "past_due", "suspended", "deleted_pending"];

export interface Allowance {
  minutes: number;
  screenings: number;
  jobLimit: number | null;
}

/**
 * What a workspace may use this period: its plan version's allowance (or the
 * live trial's, while on trial) plus anything granted or bought on top.
 */
export function allowanceFor(
  tenant: { status: TenantStatus; plan: Pick<Plan, "minutes" | "screenings" | "jobLimit"> },
  trial: Pick<TrialConfig, "minutes" | "screenings" | "jobLimit"> | null,
  subscription: { topUpMinutes: number; topUpScreenings: number } | null
): Allowance {
  const base =
    tenant.status === "trial" && trial
      ? { minutes: trial.minutes, screenings: trial.screenings, jobLimit: trial.jobLimit }
      : { minutes: tenant.plan.minutes, screenings: tenant.plan.screenings, jobLimit: tenant.plan.jobLimit };
  return {
    minutes: base.minutes + (subscription?.topUpMinutes ?? 0),
    screenings: base.screenings + (subscription?.topUpScreenings ?? 0),
    jobLimit: base.jobLimit,
  };
}

export interface MeterFigures {
  minutesUsed: number;
  screeningsUsed: number;
  interviews: number;
}

/** Usage this period, including anything recorded as overage. */
export function meterFigures(
  meter: {
    interviewMinutesUsed: number;
    overageMinutes: number;
    screeningsUsed: number;
    overageScreenings: number;
    interviewsUsed: number;
  } | null
): MeterFigures {
  return {
    minutesUsed: (meter?.interviewMinutesUsed ?? 0) + (meter?.overageMinutes ?? 0),
    screeningsUsed: (meter?.screeningsUsed ?? 0) + (meter?.overageScreenings ?? 0),
    interviews: meter?.interviewsUsed ?? 0,
  };
}

/** Monthly recurring revenue from one workspace: its own plan version's price, while paying. */
export function mrrOf(tenant: { status: TenantStatus; plan: Pick<Plan, "priceInr"> }): number {
  return PAYING.includes(tenant.status) ? tenant.plan.priceInr : 0;
}

export type StatusTone = "green" | "amber" | "red" | "neutral";

/**
 * The status chip. Account state first (suspended, past due, deleting), and
 * only then the operational one the boards show: out of minutes.
 */
export function statusChip(status: TenantStatus, minutesUsed: number, minutesAllowed: number): { label: string; tone: StatusTone } {
  switch (status) {
    case "suspended":
      return { label: "Suspended", tone: "red" };
    case "past_due":
      return { label: "Past due", tone: "red" };
    case "deleted_pending":
      return { label: "Deletion pending", tone: "red" };
    case "deleted":
      return { label: "Deleted", tone: "neutral" };
    default:
      if (minutesAllowed > 0 && minutesUsed >= minutesAllowed) return { label: "Out of minutes", tone: "amber" };
      return { label: "Active", tone: "green" };
  }
}

export function planChip(status: TenantStatus, planName: string): { label: string; tone: "indigo" | "neutral" } {
  return status === "trial" ? { label: "Trial", tone: "neutral" } : { label: planName, tone: "indigo" };
}

export function meterPercent(used: number, allowed: number): number {
  if (allowed <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.round((used / allowed) * 100));
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export type WorkspaceFilter = "all" | "paying" | "trial" | "past_due" | "suspended" | "deleted_pending";
export type WorkspaceSort = "newest" | "oldest" | "name" | "minutes";

export function searchWhere(q: string | undefined): Prisma.TenantWhereInput {
  const term = q?.trim();
  if (!term) return {};
  return {
    OR: [
      { name: { contains: term, mode: "insensitive" } },
      { slug: { contains: term, mode: "insensitive" } },
      { users: { some: { email: { contains: term, mode: "insensitive" } } } },
      { companyProfile: { gstin: { contains: term.toUpperCase() } } },
    ],
  };
}

export function filterWhere(filter: WorkspaceFilter): Prisma.TenantWhereInput {
  switch (filter) {
    case "paying":
      return { status: { in: PAYING } };
    case "trial":
      return { status: "trial" };
    case "past_due":
      return { status: "past_due" };
    case "suspended":
      return { status: "suspended" };
    case "deleted_pending":
      return { status: "deleted_pending" };
    default:
      return { status: { in: LISTED } };
  }
}

/** Counts for the filter chips, respecting the search box. */
export async function workspaceCounts(q: string | undefined, client: Db = db) {
  const grouped = await client.tenant.groupBy({
    by: ["status"],
    where: { AND: [searchWhere(q), { status: { in: LISTED } }] },
    _count: { _all: true },
  });
  const by = (s: TenantStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  return {
    all: grouped.reduce((n, g) => n + g._count._all, 0),
    paying: by("active") + by("past_due"),
    trial: by("trial"),
    past_due: by("past_due"),
    suspended: by("suspended"),
    deleted_pending: by("deleted_pending"),
  };
}

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  status: TenantStatus;
  planKey: string;
  planName: string;
  planChip: ReturnType<typeof planChip>;
  statusChip: ReturnType<typeof statusChip>;
  mrr: number;
  minutesUsed: number;
  minutesAllowed: number;
  members: number;
  createdAt: Date;
}

export async function workspaceRows(
  where: Prisma.TenantWhereInput,
  opts: { sort: WorkspaceSort; skip?: number; take?: number },
  client: Db = db
): Promise<WorkspaceRow[]> {
  const period = usagePeriod();
  const orderBy: Prisma.TenantOrderByWithRelationInput =
    opts.sort === "oldest" ? { createdAt: "asc" } : opts.sort === "name" ? { name: "asc" } : { createdAt: "desc" };

  const [tenants, trial] = await Promise.all([
    client.tenant.findMany({
      where,
      orderBy,
      // Sorting by minutes needs every row's meter, so it pages in memory.
      ...(opts.sort === "minutes" ? {} : { skip: opts.skip, take: opts.take }),
      include: {
        plan: true,
        subscription: { select: { topUpMinutes: true, topUpScreenings: true } },
        usageMeters: { where: { period } },
        users: { select: { email: true, role: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      },
    }),
    currentTrial(client),
  ]);

  let rows = tenants.map((t) => {
    const allowance = allowanceFor(t, trial, t.subscription);
    const usage = meterFigures(t.usageMeters[0] ?? null);
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      ownerEmail: t.users.find((u) => u.role === "owner")?.email ?? t.users[0]?.email ?? null,
      status: t.status,
      planKey: t.plan.key,
      planName: t.plan.name,
      planChip: planChip(t.status, t.plan.name),
      statusChip: statusChip(t.status, usage.minutesUsed, allowance.minutes),
      mrr: mrrOf(t),
      minutesUsed: usage.minutesUsed,
      minutesAllowed: allowance.minutes,
      members: t.users.length,
      createdAt: t.createdAt,
    };
  });

  if (opts.sort === "minutes") {
    rows = rows
      .sort((a, b) => b.minutesUsed - a.minutesUsed)
      .slice(opts.skip ?? 0, (opts.skip ?? 0) + (opts.take ?? rows.length));
  }
  return rows;
}

/** Everything the detail page shows, in one read. */
export async function workspaceDetail(id: string, client: Db = db) {
  const period = usagePeriod();
  const tenant = await client.tenant.findUnique({
    where: { id },
    include: {
      plan: true,
      subscription: {
        include: {
          couponRedemptions: { include: { coupon: true }, orderBy: { redeemedAt: "desc" }, take: 1 },
        },
      },
      companyProfile: true,
      usageMeters: { where: { period } },
      users: { orderBy: [{ createdAt: "asc" }] },
    },
  });
  if (!tenant) return null;

  const [trial, jobs, liveJobs, candidatesInPlay] = await Promise.all([
    currentTrial(client),
    client.job.count({ where: { tenantId: id, deletedAt: null } }),
    client.job.count({ where: { tenantId: id, deletedAt: null, status: "open" } }),
    client.candidate.count({
      where: { tenantId: id, status: { in: ["inbox", "screened", "shortlisted", "interviewed", "advance_stage"] } },
    }),
  ]);

  const allowance = allowanceFor(tenant, trial, tenant.subscription);
  const usage = meterFigures(tenant.usageMeters[0] ?? null);

  return {
    tenant,
    trial,
    allowance,
    usage,
    mrr: mrrOf(tenant),
    statusChip: statusChip(tenant.status, usage.minutesUsed, allowance.minutes),
    planChip: planChip(tenant.status, tenant.plan.name),
    jobs: { total: jobs, live: liveJobs, candidatesInPlay },
    owner: tenant.users.find((u) => u.role === "owner") ?? null,
  };
}
