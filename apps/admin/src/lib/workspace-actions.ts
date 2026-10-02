import type { AdminSession, AdminUser, Tenant, TenantStatus } from "@pratibha/prisma";
import { DEFAULT_OUTREACH_TEMPLATES, DEFAULT_PROTOCOL_INSTRUCTION } from "@pratibha/shared";
import { db, type Tx } from "@/lib/db";
import { recordActivity, SIGN_IN_AS_ACTION } from "@/lib/activity";
import { badRequest, conflict, forbidden, notFound, AdminApiError } from "@/lib/http";
import { getSetting } from "@/lib/settings";
import { currentPlan, currentTrial, packLabel } from "@/lib/pricing";
import { ensureSubscription, recordPayment, METHOD_LABEL } from "@/lib/ledger";
import { usagePeriod } from "@/lib/workspaces";
import { codeIsRecent } from "@/lib/auth/session";
import { verifyTotp } from "@/lib/auth/totp";
import { openTotp } from "@/lib/auth/secrets";
import { confirmUrl, createPortalIdentity, oneTimeToken, portalUrl } from "@/lib/gotrue";
import { sendMail } from "@/lib/email";

/**
 * What an admin does to a workspace. Each function checks the state it is
 * allowed from, makes the change and writes its activity row in one
 * transaction, and returns the sentence the panel shows afterwards. The role
 * check has already happened in the route (requireAdmin); the rules that depend
 * on the data (caps, states, a second admin) live here.
 */

const by = (admin: AdminUser) => `admin:${admin.id}`;

async function loadTenant(tx: Tx, id: string): Promise<Tenant> {
  const tenant = await tx.tenant.findUnique({ where: { id } });
  if (!tenant || tenant.status === "deleted") throw notFound("That workspace does not exist.");
  return tenant;
}

const OPEN: TenantStatus[] = ["trial", "active", "past_due", "suspended"];

function assertOpen(tenant: Tenant) {
  if (!OPEN.includes(tenant.status)) {
    throw conflict(`${tenant.name} is pending deletion. Restore it first.`);
  }
}

// ---------------------------------------------------------------------------
// Add minutes: a goodwill grant or a paid pack
// ---------------------------------------------------------------------------

export async function grantGoodwill(admin: AdminUser, tenantId: string, minutes: number, reason: string) {
  if (!Number.isInteger(minutes) || minutes <= 0) throw badRequest("Grant a whole number of minutes.");
  if (minutes > 10_000) throw badRequest("That is more minutes than any plan carries. Check the number.");
  if (admin.role === "support") {
    const cap = Number(await getSetting("admin.goodwill_cap_minutes"));
    if (minutes > cap) throw forbidden(`Support can grant up to ${cap} goodwill minutes at a time.`);
  }

  return db.$transaction(async (tx) => {
    const tenant = await loadTenant(tx, tenantId);
    assertOpen(tenant);
    const sub = await ensureSubscription(tx, tenant);
    const updated = await tx.subscription.update({
      where: { id: sub.id },
      data: { topUpMinutes: { increment: minutes } },
    });
    await recordPayment(tx, {
      tenant,
      kind: "goodwill",
      status: "captured",
      amountPaise: 0,
      method: "none",
      description: `Goodwill ${minutes} minutes`,
      minutes,
      reason,
      recordedBy: admin.id,
    });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.minutes_granted",
        summary: `${admin.name} granted ${minutes} goodwill minutes`,
        workspace: tenant,
        reason,
        before: { topUpMinutes: sub.topUpMinutes },
        after: { topUpMinutes: updated.topUpMinutes, granted: minutes },
      },
      tx
    );
    return { message: `${minutes} minutes added to ${tenant.name}. Their meter shows it on the next screen load.` };
  });
}

export async function addPack(
  admin: AdminUser,
  tenantId: string,
  input: { packId: string; method: string; reference?: string; reason: string }
) {
  return db.$transaction(async (tx) => {
    const tenant = await loadTenant(tx, tenantId);
    assertOpen(tenant);
    const pack = await tx.topupPack.findUnique({ where: { id: input.packId } });
    if (!pack || pack.status !== "published") throw badRequest("That pack is not on sale. Choose a published pack.");

    const sub = await ensureSubscription(tx, tenant);
    const field = pack.kind === "minutes" ? "topUpMinutes" : "topUpScreenings";
    const updated = await tx.subscription.update({
      where: { id: sub.id },
      data: { [field]: { increment: pack.quantity } },
    });
    const label = packLabel(pack);
    const payment = await recordPayment(tx, {
      tenant,
      kind: "top_up",
      status: "captured",
      amountPaise: pack.priceInr * 100,
      method: input.method,
      reference: input.reference ?? null,
      description: `Top up ${label}`,
      packId: pack.id,
      minutes: pack.kind === "minutes" ? pack.quantity : null,
      screenings: pack.kind === "screenings" ? pack.quantity : null,
      reason: input.reason,
      recordedBy: admin.id,
      invoiceLines: [{ description: `Top up: ${label}`, quantity: 1, unitPaise: pack.priceInr * 100 }],
    });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.pack_added",
        summary: `${admin.name} recorded a ${label} pack paid by ${METHOD_LABEL[input.method] ?? input.method}`,
        workspace: tenant,
        reason: input.reason,
        before: { [field]: sub[field] },
        after: { [field]: updated[field], invoice: payment.invoice?.number, amountPaise: payment.amountPaise },
      },
      tx
    );
    return { message: `${label} added to ${tenant.name}, invoice ${payment.invoice?.number}.` };
  });
}

// ---------------------------------------------------------------------------
// Change plan
// ---------------------------------------------------------------------------

/**
 * Move a workspace to the live version of another plan. The workspace reads
 * its plan on every screen load, so the change applies on the next one.
 * Leaving a grandfathered version is the point of a plan change: the new
 * price is today's.
 */
export async function changePlan(admin: AdminUser, tenantId: string, planKey: string, reason: string) {
  return db.$transaction(async (tx) => {
    const tenant = await loadTenant(tx, tenantId);
    assertOpen(tenant);
    const target = await currentPlan(planKey, tx);
    if (!target) throw badRequest("That plan is not published.");
    const before = await tx.plan.findUnique({ where: { id: tenant.planId } });
    if (target.id === tenant.planId && tenant.status !== "trial") {
      throw conflict(`${tenant.name} is already on ${target.name} at the published price.`);
    }

    const leavesTrial = tenant.status === "trial";
    await tx.tenant.update({
      where: { id: tenant.id },
      data: {
        planId: target.id,
        ...(leavesTrial
          ? { status: "active", statusChangedBy: by(admin), statusChangedAt: new Date(), trialEndsAt: null }
          : {}),
      },
    });
    const sub = await ensureSubscription(tx, tenant);
    await tx.subscription.update({
      where: { id: sub.id },
      data: { planId: target.id, ...(leavesTrial ? { status: "active" } : {}) },
    });

    const from = leavesTrial ? "Trial" : before?.name ?? "unknown";
    await recordActivity(
      {
        actor: admin,
        action: "workspace.plan_changed",
        summary: `${admin.name} changed the plan of ${tenant.name}, ${from} to ${target.name}`,
        workspace: tenant,
        reason,
        before: { planId: before?.id, plan: from, priceInr: before?.priceInr, version: before?.version, status: tenant.status },
        after: {
          planId: target.id,
          plan: target.name,
          priceInr: target.priceInr,
          version: target.version,
          status: leavesTrial ? "active" : tenant.status,
        },
      },
      tx
    );
    return { message: `${tenant.name} is now on ${target.name}. It applies on their next screen load.` };
  });
}

// ---------------------------------------------------------------------------
// Sign in as
// ---------------------------------------------------------------------------

/**
 * A single-use portal sign in as the workspace owner.
 *
 * Needs two step verification on the admin's account (refused with the
 * enrolment prompt otherwise), a code entered in the last few minutes (asked
 * for again if not), and a typed reason. The log row is written before the
 * token is handed over, so there is no sign in without its receipt.
 */
export async function signInAs(
  admin: AdminUser,
  session: AdminSession,
  tenantId: string,
  reason: string,
  code: string | undefined
) {
  if (!admin.totpEnabledAt || !admin.totpSecret) {
    throw new AdminApiError(
      403,
      "TWO_STEP_REQUIRED",
      "Sign in as needs two step verification on your account. Turn it on from the banner at the top of the panel."
    );
  }
  if (!(await codeIsRecent(session))) {
    if (!code) throw new AdminApiError(400, "CODE_REQUIRED", "Enter your two step code to sign in as a workspace.");
    if (!verifyTotp(openTotp(admin.totpSecret), code)) {
      throw new AdminApiError(400, "INVALID_CODE", "That two step code is not right. Try the current one.");
    }
    await db.adminSession.update({ where: { id: session.id }, data: { codeVerifiedAt: new Date() } });
  }

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    include: { users: { where: { role: "owner", removedAt: null, authProviderId: { not: null } }, orderBy: { createdAt: "asc" } } },
  });
  if (!tenant || tenant.status === "deleted") throw notFound("That workspace does not exist.");
  if (tenant.status === "suspended" || tenant.status === "deleted_pending") {
    throw conflict(`${tenant.name} is ${tenant.status === "suspended" ? "suspended" : "pending deletion"}; its members cannot sign in, and neither can Sign in as. Resume or restore it first.`);
  }
  const owner = tenant.users[0];
  if (!owner) throw conflict(`${tenant.name} has no owner with a portal login to sign in as.`);

  await recordActivity({
    actor: admin,
    action: SIGN_IN_AS_ACTION,
    summary: `${admin.name} signed in as ${tenant.name}`,
    workspace: tenant,
    reason,
    after: { asUserId: owner.id, asEmail: owner.email },
  });

  const token = await oneTimeToken("magiclink", owner.email);
  return { url: confirmUrl(token, "magiclink", `/${tenant.slug}`) };
}

// ---------------------------------------------------------------------------
// Suspend and resume
// ---------------------------------------------------------------------------

export async function suspend(admin: AdminUser, tenantId: string, reason: string) {
  return db.$transaction(async (tx) => {
    const tenant = await loadTenant(tx, tenantId);
    if (!["trial", "active", "past_due"].includes(tenant.status)) {
      throw conflict(`${tenant.name} cannot be suspended while it is ${tenant.status.replace("_", " ")}.`);
    }
    await tx.tenant.update({
      where: { id: tenant.id },
      data: { status: "suspended", previousStatus: tenant.status, statusChangedBy: by(admin), statusChangedAt: new Date() },
    });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.suspended",
        summary: `${admin.name} suspended ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { status: tenant.status },
        after: { status: "suspended" },
      },
      tx
    );
    return { message: `${tenant.name} is suspended. Sign ins, screenings and interviews are paused.` };
  });
}

export async function resume(admin: AdminUser, tenantId: string, reason: string) {
  return db.$transaction(async (tx) => {
    const tenant = await loadTenant(tx, tenantId);
    if (tenant.status !== "suspended") throw conflict(`${tenant.name} is not suspended.`);
    const back = tenant.previousStatus && tenant.previousStatus !== "suspended" ? tenant.previousStatus : "active";
    await tx.tenant.update({
      where: { id: tenant.id },
      data: { status: back, previousStatus: null, statusChangedBy: by(admin), statusChangedAt: new Date() },
    });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.resumed",
        summary: `${admin.name} resumed ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { status: "suspended" },
        after: { status: back },
      },
      tx
    );
    return { message: `${tenant.name} is running again, exactly as it was.` };
  });
}

// ---------------------------------------------------------------------------
// Delete: request, second admin confirms, 30 day hold, restore, then erasure
// ---------------------------------------------------------------------------

function assertTypedName(tenant: Tenant, typed: string) {
  if (typed.trim() !== tenant.name.trim()) {
    throw badRequest(`Type the workspace name exactly as shown: ${tenant.name}`);
  }
}

export async function requestDeletion(admin: AdminUser, tenantId: string, typedName: string, reason: string) {
  return db.$transaction(async (tx) => {
    const tenant = await loadTenant(tx, tenantId);
    assertOpen(tenant);
    assertTypedName(tenant, typedName);
    if (tenant.deletionRequestedBy) throw conflict("A deletion is already waiting for a second admin.");
    await tx.tenant.update({
      where: { id: tenant.id },
      data: { deletionRequestedBy: admin.id, deletionRequestedAt: new Date() },
    });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.deletion_requested",
        summary: `${admin.name} asked to delete ${tenant.name}; waiting for a second admin`,
        workspace: tenant,
        reason,
      },
      tx
    );
    return { message: `Deletion requested. A second admin must approve it before anything happens.` };
  });
}

/**
 * The second admin's approval. Must be a different person from the requester,
 * and an Owner or Engineer: approving is a check on the first admin, so it
 * needs someone with standing to say no. Support cannot.
 */
export async function confirmDeletion(admin: AdminUser, tenantId: string, typedName: string, reason: string) {
  if (admin.role === "support") throw forbidden("Support cannot approve a deletion.");
  const holdDays = Number(await getSetting("admin.delete_hold_days"));
  return db.$transaction(async (tx) => {
    const tenant = await loadTenant(tx, tenantId);
    assertOpen(tenant);
    assertTypedName(tenant, typedName);
    if (!tenant.deletionRequestedBy) throw conflict("No deletion has been requested for this workspace.");
    if (tenant.deletionRequestedBy === admin.id) {
      throw forbidden("A second admin must approve. You asked for this deletion, so you cannot approve it.");
    }
    const holdUntil = new Date(Date.now() + holdDays * 86_400_000);
    await tx.tenant.update({
      where: { id: tenant.id },
      data: {
        status: "deleted_pending",
        previousStatus: tenant.status,
        deletionHoldUntil: holdUntil,
        statusChangedBy: by(admin),
        statusChangedAt: new Date(),
      },
    });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.deletion_confirmed",
        summary: `${admin.name} approved deleting ${tenant.name}; it is held for ${holdDays} days`,
        workspace: tenant,
        reason,
        before: { status: tenant.status },
        after: { status: "deleted_pending", holdUntil: holdUntil.toISOString(), requestedBy: tenant.deletionRequestedBy },
      },
      tx
    );
    return { message: `${tenant.name} is held for deletion until ${holdUntil.toDateString()}. Restore works until then.` };
  });
}

export async function cancelDeletionRequest(admin: AdminUser, tenantId: string, reason: string) {
  return db.$transaction(async (tx) => {
    const tenant = await loadTenant(tx, tenantId);
    if (!tenant.deletionRequestedBy || tenant.status === "deleted_pending") {
      throw conflict("There is no open deletion request to withdraw.");
    }
    await tx.tenant.update({ where: { id: tenant.id }, data: { deletionRequestedBy: null, deletionRequestedAt: null } });
    await recordActivity(
      { actor: admin, action: "workspace.deletion_withdrawn", summary: `${admin.name} withdrew the request to delete ${tenant.name}`, workspace: tenant, reason },
      tx
    );
    return { message: "Deletion request withdrawn. Nothing was deleted." };
  });
}

export async function restore(admin: AdminUser, tenantId: string, reason: string) {
  return db.$transaction(async (tx) => {
    const tenant = await loadTenant(tx, tenantId);
    if (tenant.status !== "deleted_pending") throw conflict(`${tenant.name} is not pending deletion.`);
    const back = tenant.previousStatus && tenant.previousStatus !== "deleted_pending" ? tenant.previousStatus : "active";
    await tx.tenant.update({
      where: { id: tenant.id },
      data: {
        status: back,
        previousStatus: null,
        deletionRequestedBy: null,
        deletionRequestedAt: null,
        deletionHoldUntil: null,
        statusChangedBy: by(admin),
        statusChangedAt: new Date(),
      },
    });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.restored",
        summary: `${admin.name} restored ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { status: "deleted_pending" },
        after: { status: back },
      },
      tx
    );
    return { message: `${tenant.name} is restored, exactly as it was.` };
  });
}

/**
 * True erasure, after the hold. Every job, candidate, call and report goes, and
 * every login. What stays: the tenant row as a tombstone (status `deleted`),
 * its subscription, invoices and payments, because GST records must be kept
 * whether or not the customer is, and the activity log, which keeps no foreign
 * key to anything erased.
 */
export async function eraseHeldWorkspaces(now: Date = new Date()) {
  const due = await db.tenant.findMany({
    where: { status: "deleted_pending", deletionHoldUntil: { lte: now } },
    include: { users: { select: { authProviderId: true } } },
  });

  for (const tenant of due) {
    await db.$transaction(
      async (tx) => {
        const id = tenant.id;
        // Children first, in the order the foreign keys demand.
        await tx.assessmentReport.deleteMany({ where: { interviewCall: { candidate: { tenantId: id } } } });
        await tx.interviewCall.deleteMany({ where: { candidate: { tenantId: id } } });
        await tx.outreachEmail.deleteMany({ where: { candidate: { tenantId: id } } });
        await tx.shortlistItem.deleteMany({ where: { shortlist: { job: { tenantId: id } } } });
        await tx.approval.deleteMany({ where: { shortlist: { job: { tenantId: id } } } });
        await tx.shortlist.deleteMany({ where: { job: { tenantId: id } } });
        await tx.candidate.deleteMany({ where: { tenantId: id } });
        await tx.jobDescription.deleteMany({ where: { job: { tenantId: id } } });
        await tx.jobVersion.deleteMany({ where: { job: { tenantId: id } } });
        await tx.jobPost.deleteMany({ where: { job: { tenantId: id } } });
        await tx.callWindow.deleteMany({ where: { job: { tenantId: id } } });
        await tx.interviewProtocol.deleteMany({ where: { tenantId: id } });
        await tx.emailConnection.deleteMany({ where: { tenantId: id } });
        await tx.job.deleteMany({ where: { tenantId: id } });
        await tx.outreachTemplate.deleteMany({ where: { tenantId: id } });
        await tx.companyProfile.updateMany({ where: { tenantId: id }, data: { logoAssetId: null, description: null } });
        await tx.user.updateMany({ where: { tenantId: id }, data: { photoAssetId: null } });
        await tx.tenantAsset.deleteMany({ where: { tenantId: id } });
        await tx.user.deleteMany({ where: { tenantId: id } });
        await tx.tenant.update({
          where: { id },
          data: { status: "deleted", statusChangedBy: "system", statusChangedAt: new Date() },
        });
        await recordActivity(
          {
            actorType: "system",
            action: "workspace.erased",
            summary: `${tenant.name} was erased after its hold; invoices and payments are kept`,
            workspace: tenant,
            before: { status: "deleted_pending", holdUntil: tenant.deletionHoldUntil?.toISOString() },
            after: { status: "deleted" },
          },
          tx
        );
      },
      { timeout: 120_000 }
    );

    // Logins go after the data, outside the transaction: GoTrue is another
    // service, and a failure there must not resurrect the workspace.
    for (const u of tenant.users) {
      if (u.authProviderId) await deletePortalIdentity(u.authProviderId).catch((e) => console.error("[erase] login", e));
    }
  }
  return due.length;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

async function memberAndOwner(tenantId: string, userId: string) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, include: { users: true } });
  if (!tenant || tenant.status === "deleted") throw notFound("That workspace does not exist.");
  const member = tenant.users.find((u) => u.id === userId && !u.removedAt);
  if (!member) throw notFound("That member is not in this workspace.");
  const owner = tenant.users.find((u) => u.role === "owner" && !u.removedAt) ?? null;
  return { tenant, member, owner };
}

export async function sendMemberReset(admin: AdminUser, tenantId: string, userId: string, reason: string) {
  const { tenant, member, owner } = await memberAndOwner(tenantId, userId);
  if (!member.authProviderId) throw conflict(`${member.email} has not joined yet, so there is no password to reset.`);

  await recordActivity({
    actor: admin,
    action: "workspace.member_reset_link",
    summary: `${admin.name} sent a password reset link to ${member.name ?? member.email}`,
    workspace: tenant,
    reason,
    after: { userId: member.id, email: member.email },
  });

  const token = await oneTimeToken("recovery", member.email);
  const link = confirmUrl(token, "recovery", "/reset-password");
  const toMember = await sendMail({
    to: member.email,
    subject: "Reset your Pratibha password",
    text: `Hi ${member.name ?? ""},\n\nThe Pratibha team has sent you a link to choose a new password for ${tenant.name}:\n\n${link}\n\nIt works once, for an hour. If you did not ask for this, you can ignore it; your password stays as it is.\n\nPratibha`,
  });
  if (owner) {
    await sendMail({
      to: owner.email,
      subject: `A password reset was sent to ${member.email}`,
      text: `Hi ${owner.name ?? ""},\n\nFor your records: the Pratibha team sent a password reset link to ${member.email} in ${tenant.name}.\n\nReason given: ${reason}\n\nIf this is unexpected, reply to this email or write to start@pratibha.tech.\n\nPratibha`,
    });
  }
  return {
    message: toMember.sent
      ? `Reset link sent to ${member.email}; the owner was told.`
      : `Email is not configured, so nothing was sent. The link was logged on the server for ${member.email}.`,
  };
}

export async function removeMember(admin: AdminUser, tenantId: string, userId: string, reason: string) {
  const { tenant, member, owner } = await memberAndOwner(tenantId, userId);
  if (member.role === "owner") {
    throw conflict("The owner cannot be removed. Change ownership in the portal first.");
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: member.id },
      data: { authProviderId: null, removedAt: new Date(), removedBy: by(admin) },
    });
    await recordActivity(
      {
        actor: admin,
        action: "workspace.member_removed",
        summary: `${admin.name} removed ${member.name ?? member.email} from ${tenant.name}`,
        workspace: tenant,
        reason,
        before: { userId: member.id, email: member.email, role: member.role },
      },
      tx
    );
  });

  if (member.authProviderId) {
    await deletePortalIdentity(member.authProviderId).catch((e) => console.error("[remove member] login", e));
  }
  if (owner) {
    await sendMail({
      to: owner.email,
      subject: `${member.email} was removed from ${tenant.name}`,
      text: `Hi ${owner.name ?? ""},\n\nFor your records: the Pratibha team removed ${member.email} (${member.role}) from ${tenant.name}. They can no longer sign in. Jobs, notes and approvals they made are kept.\n\nReason given: ${reason}\n\nIf this is unexpected, reply to this email or write to start@pratibha.tech.\n\nPratibha`,
    });
  }
  return { message: `${member.email} is removed and can no longer sign in. The owner was told.` };
}

async function deletePortalIdentity(authUserId: string) {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  await fetch(`${url}/auth/v1/admin/users/${authUserId}`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createWorkspace(
  admin: AdminUser,
  input: { name: string; slug: string; ownerName: string; ownerEmail: string; planKey: string; reason: string }
) {
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) throw badRequest("The address may use lowercase letters, numbers and hyphens, 3 to 40 characters.");
  const email = input.ownerEmail.trim().toLowerCase();

  if (await db.tenant.findUnique({ where: { slug } })) throw conflict(`The address /${slug} is taken.`);
  if (await db.user.findFirst({ where: { email, removedAt: null, authProviderId: { not: null } } })) {
    throw conflict(`${email} already belongs to a workspace.`);
  }

  const onTrial = input.planKey === "trial";
  const plan = await currentPlan(onTrial ? "starter" : input.planKey);
  if (!plan) throw badRequest("Choose a published plan, or the trial.");
  const trial = onTrial ? await currentTrial() : null;

  const authUserId = await createPortalIdentity(email, input.ownerName);

  const tenant = await db.$transaction(async (tx) => {
    const t = await tx.tenant.create({
      data: {
        name: input.name.trim(),
        slug,
        planId: plan.id,
        status: onTrial ? "trial" : "active",
        trialEndsAt: onTrial ? new Date(Date.now() + (trial?.days ?? 15) * 86_400_000) : null,
        statusChangedBy: by(admin),
        statusChangedAt: new Date(),
      },
    });
    await tx.user.create({
      data: { tenantId: t.id, email, name: input.ownerName.trim(), role: "owner", authProviderId: authUserId },
    });
    await tx.outreachTemplate.createMany({
      data: DEFAULT_OUTREACH_TEMPLATES.map((tpl) => ({ ...tpl, tenantId: t.id, isDefault: true })),
    });
    await tx.interviewProtocol.create({
      data: { tenantId: t.id, jobId: null, instructionText: DEFAULT_PROTOCOL_INSTRUCTION, version: 1 },
    });
    await tx.usageMeter.create({ data: { tenantId: t.id, period: usagePeriod() } });
    await ensureSubscription(tx, t);
    await recordActivity(
      {
        actor: admin,
        action: "workspace.created",
        summary: `${admin.name} created ${t.name} on ${onTrial ? "the trial" : plan.name}`,
        workspace: t,
        reason: input.reason,
        after: { slug, ownerEmail: email, plan: onTrial ? "trial" : plan.name },
      },
      tx
    );
    return t;
  });

  const token = await oneTimeToken("recovery", email);
  const link = confirmUrl(token, "recovery", "/reset-password");
  const mail = await sendMail({
    to: email,
    subject: `Your Pratibha workspace ${tenant.name} is ready`,
    text: `Hi ${input.ownerName},\n\nThe Pratibha team has set up ${tenant.name} for you at ${portalUrl(`/${slug}`)}.\n\nChoose your password here to sign in (the link works once, for an hour):\n\n${link}\n\nPratibha`,
  });
  return {
    id: tenant.id,
    message: mail.sent
      ? `${tenant.name} is created. ${email} has an email to set their password.`
      : `${tenant.name} is created. Email is not configured, so the set-password link was logged on the server.`,
  };
}
