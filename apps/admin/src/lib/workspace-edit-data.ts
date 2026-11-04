import { GST_STATES, interviewDefaults } from "@pratibha/shared";
import { db, type Db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { MAILBOX_SELECT, primeSharedSettings } from "@/lib/workspace-edit-actions";
import { planClearsGate } from "@/lib/workspace-edit";

/**
 * What each tab of a workspace's detail page reads. Plain values only (dates
 * as ISO strings), because they go straight to client components, and never a
 * mailbox credential: mailboxes are read through MAILBOX_SELECT, an allowlist.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function companyTab(tenantId: string, client: Db = db) {
  const [profile, settings] = await Promise.all([
    client.companyProfile.findUnique({ where: { tenantId } }),
    getSettings(client),
  ]);
  return {
    profile: {
      legalName: profile?.legalName ?? "",
      addressLine: profile?.addressLine ?? "",
      city: profile?.city ?? "",
      pinCode: profile?.pinCode ?? "",
      billingState: profile?.billingState ?? "",
      gstin: profile?.gstin ?? "",
      description: profile?.description ?? "",
    },
    states: GST_STATES.map((s) => s.name as string),
    limits: {
      legalName: Number(settings["company.legal_name_max"]),
      addressLine: Number(settings["company.address_line_max"]),
      city: Number(settings["company.city_max"]),
      description: Number(settings["company.description_cap"]),
    },
  };
}

export async function jobsTab(tenantId: string, client: Db = db) {
  await primeSharedSettings();
  const [jobs, overrides] = await Promise.all([
    client.job.findMany({
      where: { tenantId },
      orderBy: [{ deletedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
      include: {
        _count: { select: { candidates: true, descriptions: { where: { approvedAt: { not: null } } } } },
      },
    }),
    client.interviewProtocol.findMany({ where: { tenantId, jobId: { not: null } } }),
  ]);
  const byJob = new Map(overrides.map((p) => [p.jobId, p]));
  return jobs.map((j) => {
    const p = byJob.get(j.id);
    return {
      id: j.id,
      title: j.title,
      status: j.status,
      screeningThreshold: j.screeningThreshold,
      candidates: j._count.candidates,
      approvedDescription: j._count.descriptions > 0,
      createdAt: iso(j.createdAt)!,
      archivedAt: iso(j.deletedAt),
      override: p ? protocolForm(p) : null,
    };
  });
}

export async function mailboxesTab(tenantId: string, client: Db = db) {
  const [rows, jobs] = await Promise.all([
    client.emailConnection.findMany({ where: { tenantId }, select: MAILBOX_SELECT, orderBy: { createdAt: "asc" } }),
    client.job.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, title: true, status: true }, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    mailboxes: rows.map((m) => ({
      id: m.id,
      provider: m.provider,
      address: m.address,
      status: m.status,
      lastPollAt: iso(m.lastPollAt),
      errorDetail: m.errorDetail,
      folder: m.folder,
      defaultJobId: m.defaultJobId,
      autoRoute: m.autoRoute,
    })),
    jobs,
  };
}

/** A protocol row as the interview dialog edits it: every field the portal's settings page edits. */
export function protocolForm(p: Record<string, any> | null) {
  const d = interviewDefaults();
  return {
    version: (p?.version as number | undefined) ?? 0,
    instructionText: (p?.instructionText as string | undefined) ?? "",
    durationMinutes: p?.durationMinutes ?? d.durationMinutes,
    difficulty: p?.difficulty ?? d.difficulty,
    minQuestions: p?.minQuestions ?? d.minQuestions,
    maxQuestions: p?.maxQuestions ?? d.maxQuestions,
    focusAreas: Array.isArray(p?.focusAreas) ? (p.focusAreas as string[]) : [],
    agentName: (p?.agentName as string | null | undefined) ?? null,
    companyName: (p?.companyName as string | null | undefined) ?? null,
    screenNotice: p?.screenNotice ?? true,
    screenSalary: p?.screenSalary ?? true,
    screenReasonLeaving: p?.screenReasonLeaving ?? true,
    screenGaps: p?.screenGaps ?? true,
    screenLocation: p?.screenLocation ?? false,
    screenWorkMode: p?.screenWorkMode ?? false,
    screenTravel: p?.screenTravel ?? false,
    screenReference: p?.screenReference ?? false,
    shareBand: p?.shareBand ?? true,
    mismatchAction: p?.mismatchAction ?? "check",
    introduceRole: p?.introduceRole ?? true,
    candidateQuestions: p?.candidateQuestions ?? true,
    hearBackDays: p === null ? d.hearBackDays : ((p.hearBackDays as number | null | undefined) ?? null),
    customQuestions: Array.isArray(p?.customQuestions) ? (p.customQuestions as string[]) : [],
  };
}

export type ProtocolForm = ReturnType<typeof protocolForm>;

export async function interviewTab(tenantId: string, planKey: string, client: Db = db) {
  await primeSharedSettings();
  const [protocol, settings] = await Promise.all([
    client.interviewProtocol.findFirst({ where: { tenantId, jobId: null } }),
    getSettings(client),
  ]);
  return {
    protocol: protocolForm(protocol),
    updatedAt: iso(protocol?.createdAt),
    rules: interviewRules(settings, planKey),
  };
}

/** What the dialog needs to offer only what the server will accept. */
export function interviewRules(settings: Record<string, unknown>, planKey: string) {
  return {
    tuningAllowed: planClearsGate(planKey, String(settings["gate.interview_tuning"])),
    maxCustomQuestions: Number(settings["interview.max_custom_questions"]),
  };
}

export async function limitsTab(tenantId: string, client: Db = db) {
  const [activeJobs, members, mailboxes] = await Promise.all([
    client.job.count({ where: { tenantId, deletedAt: null, status: { in: ["open", "paused"] } } }),
    client.user.count({ where: { tenantId, removedAt: null } }),
    client.emailConnection.count({ where: { tenantId } }),
  ]);
  return { activeJobs, members, mailboxes };
}
