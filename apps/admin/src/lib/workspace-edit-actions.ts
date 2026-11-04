import type { AdminUser, JobStatus, Prisma, Tenant, UserRole } from "@pratibha/prisma";
import { formatAddress, GUARDRAIL_ERROR, interviewDefaults, interviewProtocolSchema } from "@pratibha/shared";
import { SETTINGS } from "@pratibha/shared/settings-registry";
import type { z } from "zod";
import { db, type Tx } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import { badRequest, conflict, forbidden, notFound } from "@/lib/http";
import { getSettings } from "@/lib/settings";
import { currentTrial } from "@/lib/pricing";
import { allowanceFor } from "@/lib/workspaces";
import { sendMail } from "@/lib/email";
import { confirmUrl, createPortalIdentity, oneTimeToken } from "@/lib/gotrue";
import {
  assertInWorkspace,
  assertJobStatusChange,
  assertMailboxUpdate,
  assertQuestionBounds,
  assertRoleChange,
  changed,
  checkCompanyProfile,
  gstinWarning,
  JOB_STATUS_LABEL,
  MEMBER_ROLE_LABEL,
  normalizeSlug,
  planClearsGate,
  planOwnershipTransfer,
  slugProblem,
  tuningChanges,
  type CompanyInput,
} from "@/lib/workspace-edit";

/**
 * Editing what a workspace owns: its name and address, company profile,
 * members' roles, jobs, mailboxes and interview settings. The same shape as
 * workspace-actions.ts: the route has checked the role; each function checks
 * the data, writes the change and its activity row in one transaction, and
 * returns the sentence the panel shows.
 *
 * The admin role bypasses row security, so every write names the tenant
 * explicitly and every id from the browser is checked against it first.
 */

type WithPlan = Tenant & { plan: { key: string; name: string } };

async function loadEditable(tx: Tx, id: string): Promise<WithPlan> {
  const tenant = await tx.tenant.findUnique({ where: { id }, include: { plan: { select: { key: true, name: true } } } });
  if (!tenant || tenant.status === "deleted") throw notFound("That workspace does not exist.");
  if (tenant.status === "deleted_pending") throw conflict(`${tenant.name} is pending deletion. Restore it first.`);
  return tenant;
}

function uniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "P2002");
}

/**
 * The shared validators read Platform settings (custom question cap, interview
 * defaults) from the cache the portal's settings runtime keeps on globalThis.
 * The panel does not run that runtime, so without this they would apply the
 * built-in defaults while the portal applies what the panel saved. Fills the
 * same cache, in the runtime's shape, with the same values.
 */
export async function primeSharedSettings() {
  const values = await getSettings();
  const g = globalThis as unknown as { __pratibhaSettings?: { app?: unknown; saved: Map<string, unknown> } };
  const state = (g.__pratibhaSettings ??= {
    app: null,
    saved: new Map(),
    baseEnv: null,
    timer: null,
    listeners: new Set(),
    lastSnapshot: "",
    options: null,
  } as unknown as { app: null; saved: Map<string, unknown> });
  if (state.app) return; // A real runtime owns it.
  for (const def of SETTINGS) {
    if (def.env || def.type === "secret") continue;
    state.saved.set(def.key, values[def.key]);
  }
}

// ---------------------------------------------------------------------------
// Name and address
// ---------------------------------------------------------------------------

export async function updateDetails(admin: AdminUser, tenantId: string, input: { name?: string; slug?: string }, reason: string) {
  try {
    return await db.$transaction(async (tx) => {
      const tenant = await loadEditable(tx, tenantId);
      const next: { name?: string; slug?: string } = {};
      if (input.name !== undefined && input.name.trim() !== tenant.name) next.name = input.name.trim();
      if (input.slug !== undefined) {
        const slug = normalizeSlug(input.slug);
        if (slug !== tenant.slug) {
          const problem = slugProblem(slug);
          if (problem) throw badRequest(problem);
          if (await tx.tenant.findUnique({ where: { slug } })) throw conflict(`The address /${slug} is taken.`);
          next.slug = slug;
        }
      }
      const diff = changed({ name: tenant.name, slug: tenant.slug }, next);
      if (!diff) throw conflict("Nothing changed.");

      await tx.tenant.update({ where: { id: tenant.id }, data: next });
      await recordActivity(
        {
          actor: admin,
          action: "workspace.details_changed",
          summary: next.slug
            ? `${admin.name} moved ${tenant.name} from /${tenant.slug} to /${next.slug}${next.name ? ` and renamed it ${next.name}` : ""}`
            : `${admin.name} renamed ${tenant.name} to ${next.name}`,
          workspace: { id: tenant.id, name: next.name ?? tenant.name },
          reason,
          ...diff,
        },
        tx
      );
      return {
        message: next.slug
          ? `${next.name ?? tenant.name} now lives at /${next.slug}. Links and bookmarks to /${tenant.slug} stop working; tell the owner.`
          : `Renamed to ${next.name}. Pratibha says the new name on calls from now on.`,
      };
    });
  } catch (e) {
    if (uniqueViolation(e)) throw conflict("That address was taken a moment ago. Choose another.");
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Company profile
// ---------------------------------------------------------------------------

/** What the activity row keeps: the fields, not a second copy of the prose. */
function profileRecord(p: Record<string, unknown> | null) {
  return {
    legalName: p?.legalName ?? null,
    addressLine: p?.addressLine ?? null,
    city: p?.city ?? null,
    pinCode: p?.pinCode ?? null,
    billingState: p?.billingState ?? null,
    gstin: p?.gstin ?? null,
    hasDescription: Boolean(p?.description),
  };
}

export async function updateCompany(admin: AdminUser, tenantId: string, input: CompanyInput, reason: string) {
  const settings = await getSettings();
  const data = checkCompanyProfile(input, {
    legalName: Number(settings["company.legal_name_max"]),
    addressLine: Number(settings["company.address_line_max"]),
    city: Number(settings["company.city_max"]),
    description: Number(settings["company.description_cap"]),
  });

  return db.$transaction(async (tx) => {
    const tenant = await loadEditable(tx, tenantId);
    const before = await tx.companyProfile.findUnique({ where: { tenantId: tenant.id } });
    // The single address block older readers (invoices) use, kept in step.
    const write = {
      ...data,
      billingAddress: formatAddress({ addressLine: data.addressLine, city: data.city, pinCode: data.pinCode, state: data.billingState }),
    };
    const diff = changed(
      { ...profileRecord(before), description: before?.description ?? null, billingAddress: before?.billingAddress ?? null },
      write
    );
    if (!diff) throw conflict("Nothing changed.");

    const profile = await tx.companyProfile.upsert({
      where: { tenantId: tenant.id },
      update: write,
      create: { tenantId: tenant.id, ...write },
    });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.company_profile_changed",
        summary: `${admin.name} edited the company profile of ${tenant.name}`,
        workspace: tenant,
        reason,
        before: profileRecord(before),
        after: profileRecord(profile),
      },
      tx
    );
    const warning = gstinWarning(profile.gstin, profile.billingState);
    return { message: warning ? `Saved. ${warning}` : "Company profile saved. The next invoice uses it." };
  });
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

async function membersOf(tx: Tx, tenantId: string) {
  const tenant = await loadEditable(tx, tenantId);
  const users = await tx.user.findMany({ where: { tenantId: tenant.id }, orderBy: { createdAt: "asc" } });
  return { tenant, users };
}

const displayName = (u: { name: string | null; email: string }) => u.name ?? u.email;

export async function changeMemberRole(admin: AdminUser, tenantId: string, userId: string, role: UserRole, reason: string) {
  const result = await db.$transaction(async (tx) => {
    const { tenant, users } = await membersOf(tx, tenantId);
    const member = assertRoleChange(users, userId, role);
    await tx.user.updateMany({ where: { id: member.id, tenantId: tenant.id }, data: { role } });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.member_role_changed",
        summary: `${admin.name} made ${displayName(member)} ${MEMBER_ROLE_LABEL[role]} in ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { userId: member.id, email: member.email, role: member.role },
        after: { userId: member.id, email: member.email, role },
      },
      tx
    );
    return { tenant, member, owner: users.find((u) => u.role === "owner" && !u.removedAt) ?? null };
  });

  const { tenant, member, owner } = result;
  if (owner) {
    await sendMail({
      kind: "member_change_notice",
      tenantId: tenant.id,
      to: owner.email,
      subject: `${member.email} is now ${MEMBER_ROLE_LABEL[role]} in ${tenant.name}`,
      text: `Hi ${owner.name ?? ""},\n\nFor your records: the Pratibha team changed ${member.email} from ${MEMBER_ROLE_LABEL[member.role]} to ${MEMBER_ROLE_LABEL[role]} in ${tenant.name}.\n\nReason given: ${reason}\n\nIf this is unexpected, reply to this email or write to start@pratibha.tech.\n\nPratibha`,
    });
  }
  return { message: `${member.email} is now ${MEMBER_ROLE_LABEL[role]}. It applies on their next screen load; the owner was told.` };
}

export async function transferOwnership(admin: AdminUser, tenantId: string, userId: string, reason: string) {
  const result = await db.$transaction(async (tx) => {
    const { tenant, users } = await membersOf(tx, tenantId);
    const { target, demote } = planOwnershipTransfer(users, userId);
    if (demote.length) {
      await tx.user.updateMany({ where: { tenantId: tenant.id, id: { in: demote.map((u) => u.id) } }, data: { role: "admin" } });
    }
    await tx.user.updateMany({ where: { id: target.id, tenantId: tenant.id }, data: { role: "owner" } });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.ownership_transferred",
        summary: `${admin.name} made ${displayName(target)} the owner of ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { owners: demote.map((u) => u.email), newOwnerRole: target.role },
        after: { owner: target.email, steppedDownToAdmin: demote.map((u) => u.email) },
      },
      tx
    );
    return { tenant, target, demote };
  });

  const { tenant, target, demote } = result;
  for (const person of [target, ...demote]) {
    await sendMail({
      kind: "member_change_notice",
      tenantId: tenant.id,
      to: person.email,
      subject: `${target.email} is now the owner of ${tenant.name}`,
      text: `Hi ${person.name ?? ""},\n\nThe Pratibha team has made ${target.email} the owner of ${tenant.name}.${person.id === target.id ? " You now manage the team and billing." : " You stay in the workspace as an Admin."}\n\nReason given: ${reason}\n\nIf this is unexpected, reply to this email or write to start@pratibha.tech.\n\nPratibha`,
    });
  }
  return {
    message: `${target.email} is the owner of ${tenant.name}${demote.length ? `; ${demote.map((u) => u.email).join(", ")} stepped down to Admin` : ""}. Everyone involved was emailed.`,
  };
}

/**
 * The portal adds a teammate as a row with no login and leaves them to sign
 * up, which never links back. This sends them in: a portal login for that
 * email, linked to their row, and a one-time link to choose a password, the
 * same way Create workspace sends in an owner.
 */
export async function sendInvite(admin: AdminUser, tenantId: string, userId: string, reason: string) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant || tenant.status === "deleted") throw notFound("That workspace does not exist.");
  if (tenant.status === "deleted_pending") throw conflict(`${tenant.name} is pending deletion. Restore it first.`);
  const member = assertInWorkspace(await db.user.findFirst({ where: { id: userId, tenantId, removedAt: null } }), tenantId, "member");
  if (member.authProviderId) throw conflict(`${member.email} has already joined. Send a password reset link instead.`);
  if (await db.user.findFirst({ where: { email: member.email, removedAt: null, authProviderId: { not: null } } })) {
    throw conflict(`${member.email} already signs in to another workspace, and a login belongs to one workspace.`);
  }

  const authUserId = await createPortalIdentity(member.email, member.name ?? member.email.split("@")[0]);
  await db.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: member.id, tenantId, authProviderId: null, removedAt: null },
      data: { authProviderId: authUserId },
    });
    if (!count) throw conflict(`${member.email} changed while the invite was being sent. Reload and try again.`);
    await recordActivity(
      {
        actor: admin,
        action: "workspace.member_invited",
        summary: `${admin.name} sent ${member.email} an invite to ${tenant.name}`,
        workspace: tenant,
        reason,
        after: { userId: member.id, email: member.email, role: member.role },
      },
      tx
    );
  });

  const token = await oneTimeToken("recovery", member.email);
  const link = confirmUrl(token, "recovery", "/reset-password");
  const mail = await sendMail({
    kind: "member_invite",
    tenantId: tenant.id,
    to: member.email,
    subject: `You have been added to ${tenant.name} on Pratibha`,
    text: `Hi ${member.name ?? ""},\n\nYou have been added to ${tenant.name} on Pratibha as ${MEMBER_ROLE_LABEL[member.role]}.\n\nChoose your password here to sign in (the link works once, for an hour):\n\n${link}\n\nPratibha`,
  });
  return {
    message: mail.sent
      ? `${member.email} has an email to set their password and join.`
      : `Their login is ready. Email is not configured, so the set-password link was logged on the server.`,
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function loadJob(tx: Tx, tenantId: string, jobId: string) {
  const job = await tx.job.findFirst({
    where: { id: jobId, tenantId },
    include: {
      _count: { select: { descriptions: { where: { approvedAt: { not: null } } } } },
      posts: { where: { status: "posted" }, select: { id: true } },
    },
  });
  return assertInWorkspace(job, tenantId, "job");
}

export async function updateJob(
  admin: AdminUser,
  tenantId: string,
  jobId: string,
  input: { title?: string; status?: JobStatus; screeningThreshold?: number | null },
  reason: string
) {
  return db.$transaction(async (tx) => {
    const tenant = await loadEditable(tx, tenantId);
    const job = await loadJob(tx, tenant.id, jobId);
    if (job.deletedAt) throw conflict("This job is archived. Restore it before changing it.");

    const next = {
      ...(input.title !== undefined && { title: input.title.trim() }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.screeningThreshold !== undefined && { screeningThreshold: input.screeningThreshold }),
    };
    const diff = changed({ title: job.title, status: job.status, screeningThreshold: job.screeningThreshold }, next);
    if (!diff) throw conflict("Nothing changed.");

    if (next.status && next.status !== job.status) {
      const [trial, sub, activeJobs] = await Promise.all([
        currentTrial(tx),
        tx.subscription.findUnique({ where: { tenantId: tenant.id }, select: { topUpMinutes: true, topUpScreenings: true } }),
        tx.job.count({ where: { tenantId: tenant.id, deletedAt: null, status: { in: ["open", "paused"] } } }),
      ]);
      const plan = await tx.plan.findUniqueOrThrow({ where: { id: tenant.planId } });
      assertJobStatusChange({
        from: job.status,
        to: next.status,
        archived: false,
        hasApprovedDescription: job._count.descriptions > 0,
        activeJobs,
        jobLimit: allowanceFor({ status: tenant.status, plan }, trial, sub).jobLimit,
      });
    }

    await tx.job.updateMany({ where: { id: job.id, tenantId: tenant.id }, data: next });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.job_edited",
        summary: `${admin.name} edited the job ${job.title} in ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { jobId: job.id, ...diff.before },
        after: { jobId: job.id, ...diff.after },
      },
      tx
    );
    const parts = [`${next.title ?? job.title} saved`];
    if (next.status && next.status !== job.status) parts.push(`now ${JOB_STATUS_LABEL[next.status].toLowerCase()}`);
    const republish = next.title && next.title !== job.title && job.posts.length > 0;
    return {
      message: `${parts.join(", ")}.${republish ? " Their careers page shows the old title until they republish." : ""}`,
    };
  });
}

/** Archive, never delete: candidates, calls and reports hang off a job. Mirrors the portal's DELETE. */
export async function archiveJob(admin: AdminUser, tenantId: string, jobId: string, reason: string) {
  return db.$transaction(async (tx) => {
    const tenant = await loadEditable(tx, tenantId);
    const job = await loadJob(tx, tenant.id, jobId);
    if (job.deletedAt) throw conflict("This job is already archived.");
    // deletedBy names a workspace member; an admin is not one, so it stays
    // empty and the activity row says who.
    await tx.job.updateMany({ where: { id: job.id, tenantId: tenant.id }, data: { deletedAt: new Date(), deletedBy: null, status: "closed" } });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.job_archived",
        summary: `${admin.name} archived the job ${job.title} in ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { jobId: job.id, status: job.status, archived: false },
        after: { jobId: job.id, status: "closed", archived: true },
      },
      tx
    );
    return { message: `${job.title} is archived and closed. Its candidates, calls and reports are kept; Restore brings it back.` };
  });
}

export async function restoreJob(admin: AdminUser, tenantId: string, jobId: string, reason: string) {
  return db.$transaction(async (tx) => {
    const tenant = await loadEditable(tx, tenantId);
    const job = await loadJob(tx, tenant.id, jobId);
    if (!job.deletedAt) throw conflict("This job is not archived.");
    await tx.job.updateMany({ where: { id: job.id, tenantId: tenant.id }, data: { deletedAt: null, deletedBy: null } });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.job_restored",
        summary: `${admin.name} restored the job ${job.title} in ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { jobId: job.id, archived: true, archivedAt: job.deletedAt.toISOString() },
        after: { jobId: job.id, archived: false, status: job.status },
      },
      tx
    );
    return { message: `${job.title} is back in the workspace, closed. The customer reopens it when they are ready.` };
  });
}

// ---------------------------------------------------------------------------
// Interview settings
// ---------------------------------------------------------------------------

export type ProtocolInput = z.infer<typeof interviewProtocolSchema>;

/**
 * The shared schema, with the Platform settings the portal validates against
 * and the guardrail refusal surfaced word for word, as the portal does.
 */
export async function parseProtocol(raw: unknown): Promise<ProtocolInput> {
  await primeSharedSettings();
  const parsed = interviewProtocolSchema.safeParse(raw);
  if (!parsed.success) {
    const guardrail = parsed.error.issues.find((i) => i.message === GUARDRAIL_ERROR);
    if (guardrail) throw badRequest(GUARDRAIL_ERROR, { field: guardrail.path.join(".") });
    const first = parsed.error.issues[0];
    throw badRequest(first?.message ?? "Invalid interview settings", parsed.error.flatten());
  }
  return parsed.data;
}

/** Fields the activity row compares; the instruction text is long, so only whether it changed. */
function protocolRecord(p: Record<string, unknown>) {
  const { instructionText, id: _id, tenantId: _t, jobId: _j, createdAt: _c, updatedBy: _u, ...rest } = p;
  return { ...rest, instructionLength: typeof instructionText === "string" ? instructionText.length : 0 };
}

/**
 * Save interview settings for the workspace (jobId absent) or one job. Exactly
 * the portal's PUT: the row is updated in place with version + 1, or created
 * at version 1 from the Platform defaults; the plan gate holds tuning fields.
 */
export async function saveInterview(admin: AdminUser, tenantId: string, data: ProtocolInput, reason: string) {
  const settings = await getSettings();
  return db.$transaction(async (tx) => {
    const tenant = await loadEditable(tx, tenantId);
    const jobId = data.jobId ?? null;
    let jobTitle: string | null = null;
    if (jobId) {
      const job = assertInWorkspace(await tx.job.findFirst({ where: { id: jobId, tenantId: tenant.id } }), tenant.id, "job");
      if (job.deletedAt) throw conflict("This job is archived. Restore it before changing it.");
      jobTitle = job.title;
    }

    const existing = jobId
      ? await tx.interviewProtocol.findFirst({ where: { tenantId: tenant.id, jobId } })
      : await tx.interviewProtocol.findFirst({ where: { tenantId: tenant.id, jobId: null } });

    if (!planClearsGate(tenant.plan.key, String(settings["gate.interview_tuning"]))) {
      const tuned = tuningChanges(existing as Record<string, unknown> | null, data as Record<string, unknown>);
      if (tuned.length && existing) {
        throw forbidden(`Interview style tuning is not on ${tenant.name}'s plan (${tenant.plan.name}). Length and question counts can still be changed.`);
      }
    }

    const fields = {
      instructionText: data.instructionText,
      ...(data.durationMinutes !== undefined && { durationMinutes: data.durationMinutes }),
      ...(data.difficulty !== undefined && { difficulty: data.difficulty }),
      ...(data.minQuestions !== undefined && { minQuestions: data.minQuestions }),
      ...(data.maxQuestions !== undefined && { maxQuestions: data.maxQuestions }),
      ...(data.focusAreas !== undefined && { focusAreas: data.focusAreas }),
      ...(data.agentName !== undefined && { agentName: data.agentName }),
      ...(data.companyName !== undefined && { companyName: data.companyName }),
      ...(data.screenNotice !== undefined && { screenNotice: data.screenNotice }),
      ...(data.screenSalary !== undefined && { screenSalary: data.screenSalary }),
      ...(data.screenReasonLeaving !== undefined && { screenReasonLeaving: data.screenReasonLeaving }),
      ...(data.screenGaps !== undefined && { screenGaps: data.screenGaps }),
      ...(data.screenLocation !== undefined && { screenLocation: data.screenLocation }),
      ...(data.screenWorkMode !== undefined && { screenWorkMode: data.screenWorkMode }),
      ...(data.screenTravel !== undefined && { screenTravel: data.screenTravel }),
      ...(data.screenReference !== undefined && { screenReference: data.screenReference }),
      ...(data.shareBand !== undefined && { shareBand: data.shareBand }),
      ...(data.mismatchAction !== undefined && { mismatchAction: data.mismatchAction }),
      ...(data.introduceRole !== undefined && { introduceRole: data.introduceRole }),
      ...(data.candidateQuestions !== undefined && { candidateQuestions: data.candidateQuestions }),
      ...(data.hearBackDays !== undefined && { hearBackDays: data.hearBackDays }),
      ...(data.customQuestions !== undefined && { customQuestions: data.customQuestions }),
    } satisfies Prisma.InterviewProtocolUncheckedUpdateInput;

    const defaults = interviewDefaults();
    assertQuestionBounds(
      fields.minQuestions ?? existing?.minQuestions ?? defaults.minQuestions,
      fields.maxQuestions ?? existing?.maxQuestions ?? defaults.maxQuestions
    );

    // updatedBy names a workspace member; an admin is not one, so it is
    // cleared rather than left crediting the last member who saved.
    const protocol = existing
      ? await tx.interviewProtocol.update({
          where: { id: existing.id },
          data: { ...fields, version: existing.version + 1, updatedBy: null },
        })
      : await tx.interviewProtocol.create({
          data: { tenantId: tenant.id, jobId, ...defaults, ...fields, version: 1, updatedBy: null },
        });

    const diff = changed(existing ? protocolRecord(existing) : {}, protocolRecord(protocol));
    const scope = jobTitle ? `the job ${jobTitle}` : "the workspace";
    await recordActivity(
      {
        actor: admin,
        action: "workspace.interview_settings_saved",
        summary: `${admin.name} saved interview settings for ${scope} in ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { jobId, version: existing?.version ?? null, ...(diff?.before ?? {}) },
        after: { jobId, version: protocol.version, ...(diff?.after ?? {}) },
      },
      tx
    );
    return { message: `Interview settings for ${scope} saved as version ${protocol.version}. The next call uses them.` };
  });
}

/** A job stops overriding and goes back to the workspace default. Mirrors the portal's DELETE. */
export async function resetJobInterview(admin: AdminUser, tenantId: string, jobId: string, reason: string) {
  return db.$transaction(async (tx) => {
    const tenant = await loadEditable(tx, tenantId);
    const job = assertInWorkspace(await tx.job.findFirst({ where: { id: jobId, tenantId: tenant.id } }), tenant.id, "job");
    const existing = await tx.interviewProtocol.findFirst({ where: { tenantId: tenant.id, jobId: job.id } });
    if (!existing) throw conflict(`${job.title} already uses the workspace's interview settings.`);
    await tx.interviewProtocol.deleteMany({ where: { tenantId: tenant.id, jobId: job.id } });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.interview_override_removed",
        summary: `${admin.name} put ${job.title} back on the workspace interview settings in ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { jobId: job.id, version: existing.version, durationMinutes: existing.durationMinutes },
        after: { jobId: job.id, override: false },
      },
      tx
    );
    return { message: `${job.title} now uses the workspace's interview settings.` };
  });
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

/** Never a secret, a token or the private forwarding address: only what the list shows. */
export const MAILBOX_SELECT = {
  id: true,
  tenantId: true,
  provider: true,
  address: true,
  status: true,
  lastPollAt: true,
  errorDetail: true,
  createdAt: true,
  folder: true,
  defaultJobId: true,
  autoRoute: true,
} satisfies Prisma.EmailConnectionSelect;

export async function updateMailbox(
  admin: AdminUser,
  tenantId: string,
  connectionId: string,
  input: { status?: "connected" | "revoked"; defaultJobId?: string | null; autoRoute?: boolean },
  reason: string
) {
  return db.$transaction(async (tx) => {
    const tenant = await loadEditable(tx, tenantId);
    const connection = assertInWorkspace(
      await tx.emailConnection.findFirst({ where: { id: connectionId, tenantId: tenant.id }, select: MAILBOX_SELECT }),
      tenant.id,
      "mailbox"
    );
    if (input.defaultJobId) {
      const job = await tx.job.findFirst({ where: { id: input.defaultJobId, tenantId: tenant.id, deletedAt: null } });
      if (!job) throw badRequest("Choose a job in this workspace.");
    }
    assertMailboxUpdate(connection, input);

    const before = { status: connection.status, defaultJobId: connection.defaultJobId, autoRoute: connection.autoRoute };
    const diff = changed(before, input);
    if (!diff) throw conflict("Nothing changed.");

    await tx.emailConnection.updateMany({
      where: { id: connection.id, tenantId: tenant.id },
      data: {
        ...(input.status !== undefined && { status: input.status }),
        ...(input.defaultJobId !== undefined && { defaultJobId: input.defaultJobId }),
        ...(input.autoRoute !== undefined && { autoRoute: input.autoRoute }),
      },
    });
    const verb = input.status === "revoked" ? "paused" : input.status === "connected" ? "resumed" : "edited";
    await recordActivity(
      {
        actor: admin,
        action: `workspace.mailbox_${verb}`,
        summary: `${admin.name} ${verb} the mailbox ${connection.address} in ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { connectionId: connection.id, ...diff.before },
        after: { connectionId: connection.id, ...diff.after },
      },
      tx
    );
    return {
      message:
        verb === "paused"
          ? `${connection.address} is paused. Nothing is read from it until it is resumed.`
          : verb === "resumed"
            ? `${connection.address} is resumed. The next check picks up new mail.`
            : `${connection.address} saved. New mail is filed the new way.`,
    };
  });
}

/** Disconnect for good. Candidates already filed are the customer's hiring data and stay. */
export async function disconnectMailbox(admin: AdminUser, tenantId: string, connectionId: string, reason: string) {
  return db.$transaction(async (tx) => {
    const tenant = await loadEditable(tx, tenantId);
    const connection = assertInWorkspace(
      await tx.emailConnection.findFirst({ where: { id: connectionId, tenantId: tenant.id }, select: MAILBOX_SELECT }),
      tenant.id,
      "mailbox"
    );
    await tx.emailConnection.deleteMany({ where: { id: connection.id, tenantId: tenant.id } });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.mailbox_disconnected",
        summary: `${admin.name} disconnected the mailbox ${connection.address} from ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { connectionId: connection.id, provider: connection.provider, address: connection.address, status: connection.status },
      },
      tx
    );
    return { message: `${connection.address} is disconnected. Candidates already filed from it stay.` };
  });
}
