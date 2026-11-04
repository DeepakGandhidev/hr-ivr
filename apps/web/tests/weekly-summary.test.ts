import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Monday summary, against a fake database: when it is due, what it counts,
 * who gets it, and that idle workspaces get nothing.
 */

interface Where {
  tenantId?: string;
  candidate?: { tenantId?: string };
}

// Figures per workspace, keyed the way each query filters.
const figures: Record<string, { candidates: number; screenings: number; shortlisted: number; calls: number; openJobs: number; minutes: number }> = {};
const tenantOf = (where: Where) => where.tenantId ?? where.candidate?.tenantId ?? "";

const prisma = vi.hoisted(() => ({
  tenant: { findMany: vi.fn() },
  candidate: { count: vi.fn() },
  screening: { count: vi.fn() },
  shortlistItem: { count: vi.fn() },
  interviewCall: { count: vi.fn() },
  job: { count: vi.fn() },
  usageMeter: { findUnique: vi.fn() },
  subscription: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
  trialConfig: { findFirst: vi.fn().mockResolvedValue(null) },
}));
vi.mock("@pratibha/prisma", () => ({ adminPrisma: prisma }));

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({ sendEmail }));

import {
  __resetWeeklySummary,
  isoWeekOf,
  runWeeklySummaries,
  summaryWeekAt,
  weeklySummaryEmail,
} from "@/lib/weekly-summary";

// Monday 19 Oct 2026, 09:00 India time (03:30 UTC).
const MONDAY_9_IST = new Date("2026-10-19T03:30:00Z");

const plan = { id: "plan_growth", key: "growth", name: "Growth", minutes: 600, screenings: 500, jobLimit: 10 };
const tenant = (id: string, status = "active") => ({ id, name: `Company ${id}`, slug: id, status, planId: plan.id, plan });

beforeEach(() => {
  vi.clearAllMocks();
  __resetWeeklySummary();
  for (const k of Object.keys(figures)) delete figures[k];

  prisma.candidate.count.mockImplementation(async ({ where }: { where: Where }) => figures[tenantOf(where)]?.candidates ?? 0);
  prisma.screening.count.mockImplementation(async ({ where }: { where: Where }) => figures[tenantOf(where)]?.screenings ?? 0);
  prisma.shortlistItem.count.mockImplementation(async ({ where }: { where: Where }) => figures[tenantOf(where)]?.shortlisted ?? 0);
  prisma.interviewCall.count.mockImplementation(async ({ where }: { where: Where }) => figures[tenantOf(where)]?.calls ?? 0);
  prisma.job.count.mockImplementation(async ({ where }: { where: Where }) => figures[tenantOf(where)]?.openJobs ?? 0);
  prisma.usageMeter.findUnique.mockImplementation(async ({ where }: { where: { tenantId_period: { tenantId: string } } }) => ({
    interviewMinutesUsed: figures[where.tenantId_period.tenantId]?.minutes ?? 0,
  }));
  prisma.subscription.findUnique.mockResolvedValue({ topUpMinutes: 60 });
  sendEmail.mockResolvedValue({ ok: true });
});

describe("when the summary is due", () => {
  it("is Monday from 09:00 India time, and reports the Monday to Sunday before", () => {
    expect(summaryWeekAt(new Date("2026-10-19T03:29:00Z"))).toBeNull(); // 08:59 IST
    const week = summaryWeekAt(MONDAY_9_IST)!;
    expect(week.start.toISOString()).toBe("2026-10-11T18:30:00.000Z"); // Mon 12 Oct, 00:00 IST
    expect(week.end.toISOString()).toBe("2026-10-18T18:30:00.000Z"); // Mon 19 Oct, 00:00 IST
    expect(week.isoWeek).toBe("2026-W42");
    // Still Monday in India late in the UTC evening before.
    expect(summaryWeekAt(new Date("2026-10-19T18:00:00Z"))?.isoWeek).toBe("2026-W42");
  });

  it("is not due on any other day", () => {
    expect(summaryWeekAt(new Date("2026-10-18T05:00:00Z"))).toBeNull(); // Sunday
    expect(summaryWeekAt(new Date("2026-10-20T05:00:00Z"))).toBeNull(); // Tuesday
    expect(summaryWeekAt(new Date("2026-10-19T18:30:00Z"))).toBeNull(); // Tuesday 00:00 IST
  });

  it("numbers weeks the ISO way across a year end", () => {
    expect(isoWeekOf(new Date("2026-12-28T00:00:00Z"))).toBe("2026-W53");
    expect(isoWeekOf(new Date("2027-01-04T00:00:00Z"))).toBe("2027-W01");
  });
});

describe("runWeeklySummaries", () => {
  it("sends each owner and admin who wants it the week's counts, keyed per person and week", async () => {
    prisma.tenant.findMany.mockResolvedValue([tenant("busy"), tenant("idle")]);
    figures.busy = { candidates: 12, screenings: 9, shortlisted: 4, calls: 3, openJobs: 2, minutes: 140 };
    figures.idle = { candidates: 0, screenings: 0, shortlisted: 0, calls: 0, openJobs: 0, minutes: 0 };
    prisma.user.findMany.mockResolvedValue([
      { id: "u_owner", email: "owner@busy.test", notificationPrefs: null },
      { id: "u_admin", email: "admin@busy.test", notificationPrefs: { weekly_summary: true } },
      { id: "u_quiet", email: "quiet@busy.test", notificationPrefs: { weekly_summary: false } },
    ]);

    const sent = await runWeeklySummaries(new Date("2026-10-19T04:30:00Z"));

    expect(sent).toBe(2);
    expect(prisma.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ["trial", "active"] } } })
    );
    // Recipients are asked for once, for the busy workspace only, owners and admins still in it.
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      tenantId: "busy",
      role: { in: ["owner", "admin"] },
      removedAt: null,
    });

    expect(sendEmail.mock.calls.map((c) => c[0].to)).toEqual(["owner@busy.test", "admin@busy.test"]);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.kind).toBe("weekly_summary");
    expect(mail.tenantId).toBe("busy");
    expect(mail.dedupeKey).toBe("weekly_summary:busy:u_owner:2026-W42");
    expect(sendEmail.mock.calls[1][0].dedupeKey).toBe("weekly_summary:busy:u_admin:2026-W42");
    expect(mail.subject).toContain("12 Oct – 18 Oct 2026");
    expect(mail.body).toContain("New applications: 12");
    expect(mail.body).toContain("Screened: 9");
    expect(mail.body).toContain("Shortlisted: 4");
    expect(mail.body).toContain("Interviews completed: 3");
    expect(mail.body).toContain("Interview minutes used this month: 140 of 660"); // 600 plan + 60 top-up
    expect(mail.body).toContain("Open jobs: 2");
    expect(mail.body).toMatch(/\/busy$/m);
  });

  it("counts only the week, pinned to the workspace", async () => {
    prisma.tenant.findMany.mockResolvedValue([tenant("busy")]);
    figures.busy = { candidates: 1, screenings: 0, shortlisted: 0, calls: 0, openJobs: 0, minutes: 0 };
    prisma.user.findMany.mockResolvedValue([{ id: "u1", email: "o@busy.test", notificationPrefs: null }]);

    await runWeeklySummaries(MONDAY_9_IST);

    const inWeek = { gte: new Date("2026-10-11T18:30:00Z"), lt: new Date("2026-10-18T18:30:00Z") };
    expect(prisma.candidate.count.mock.calls[0][0].where).toEqual({ tenantId: "busy", createdAt: inWeek, notApplicationAt: null });
    expect(prisma.screening.count.mock.calls[0][0].where).toEqual({ createdAt: inWeek, failed: false, candidate: { tenantId: "busy" } });
    expect(prisma.interviewCall.count.mock.calls[0][0].where).toEqual({
      status: "completed",
      startedAt: inWeek,
      candidate: { tenantId: "busy" },
    });
    expect(prisma.job.count.mock.calls[0][0].where).toEqual({ tenantId: "busy", status: "open" });
  });

  it("still sends a workspace with open jobs and a quiet week", async () => {
    prisma.tenant.findMany.mockResolvedValue([tenant("open")]);
    figures.open = { candidates: 0, screenings: 0, shortlisted: 0, calls: 0, openJobs: 1, minutes: 0 };
    prisma.user.findMany.mockResolvedValue([{ id: "u1", email: "o@open.test", notificationPrefs: null }]);

    expect(await runWeeklySummaries(MONDAY_9_IST)).toBe(1);
  });

  it("does nothing before 09:00 on Monday, or on another day", async () => {
    prisma.tenant.findMany.mockResolvedValue([tenant("busy")]);
    expect(await runWeeklySummaries(new Date("2026-10-19T03:00:00Z"))).toBe(0);
    expect(await runWeeklySummaries(new Date("2026-10-20T04:30:00Z"))).toBe(0);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not go through the workspaces again in the same week", async () => {
    prisma.tenant.findMany.mockResolvedValue([tenant("busy")]);
    figures.busy = { candidates: 1, screenings: 0, shortlisted: 0, calls: 0, openJobs: 0, minutes: 0 };
    prisma.user.findMany.mockResolvedValue([{ id: "u1", email: "o@busy.test", notificationPrefs: null }]);

    await runWeeklySummaries(MONDAY_9_IST);
    await runWeeklySummaries(new Date("2026-10-19T03:45:00Z"));
    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("keeps going when one workspace fails, and tries it again on the next tick", async () => {
    prisma.tenant.findMany.mockResolvedValue([tenant("broken"), tenant("busy")]);
    figures.busy = { candidates: 1, screenings: 0, shortlisted: 0, calls: 0, openJobs: 0, minutes: 0 };
    prisma.job.count.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    prisma.user.findMany.mockResolvedValue([{ id: "u1", email: "o@busy.test", notificationPrefs: null }]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runWeeklySummaries(MONDAY_9_IST)).toBe(1);
    await runWeeklySummaries(new Date("2026-10-19T03:45:00Z"));
    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(2);
  });
});

describe("weeklySummaryEmail", () => {
  it("says unlimited for a plan without a minute cap", () => {
    const { body } = weeklySummaryEmail({
      company: "Acme",
      slug: "acme",
      week: summaryWeekAt(MONDAY_9_IST)!,
      stats: { applications: 1, screened: 0, shortlisted: 0, interviews: 0, openJobs: 1, minutesUsed: 5, minutesAllowance: null },
    });
    expect(body).toContain("5 of unlimited");
    expect(body).toContain("hiring went at Acme");
  });
});
