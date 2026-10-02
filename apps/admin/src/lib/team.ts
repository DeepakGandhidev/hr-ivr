import { randomBytes } from "node:crypto";
import type { AdminRole, AdminUser } from "@pratibha/prisma";
import { db } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import { badRequest, conflict, notFound } from "@/lib/http";
import { hashToken } from "@/lib/auth/session";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { sendMail } from "@/lib/email";

/**
 * Who can open the panel. Owner only, for every action here.
 *
 * Two rules keep the panel from locking itself out: nobody can deactivate or
 * demote themselves, and the last active Owner cannot be deactivated or
 * demoted by anyone.
 */
const INVITE_HOURS = 72;

function inviteLink(token: string) {
  const base = (process.env.ADMIN_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
  return `${base}/invite/${token}`;
}

async function issueInvite(admin: AdminUser, target: { id: string; name: string; email: string; role: AdminRole }) {
  const token = randomBytes(32).toString("base64url");
  await db.adminUser.update({
    where: { id: target.id },
    data: { inviteTokenHash: hashToken(token), inviteExpiresAt: new Date(Date.now() + INVITE_HOURS * 3_600_000) },
  });
  const link = inviteLink(token);
  const mail = await sendMail({
    to: target.email,
    subject: "You have been invited to the Pratibha admin panel",
    text: `Hi ${target.name},\n\n${admin.name} has invited you to the Pratibha admin panel as ${ROLE_LABEL[target.role]}.\n\nSet your password here within ${INVITE_HOURS} hours:\n\n${link}\n\nYou will then turn on two step verification.\n\nPratibha`,
  });
  return { link, sent: mail.sent };
}

export async function inviteAdmin(admin: AdminUser, input: { name: string; email: string; role: AdminRole }) {
  const email = input.email.trim().toLowerCase();
  const existing = await db.adminUser.findUnique({ where: { email } });
  if (existing && !existing.deactivatedAt) throw conflict(`${email} is already an admin.`);

  const target = existing
    ? await db.adminUser.update({
        where: { id: existing.id },
        data: { name: input.name.trim(), role: input.role, deactivatedAt: null, deactivatedBy: null, passwordHash: null, totpSecret: null, totpEnabledAt: null, invitedBy: admin.id },
      })
    : await db.adminUser.create({ data: { name: input.name.trim(), email, role: input.role, invitedBy: admin.id } });

  const invite = await issueInvite(admin, target);
  await recordActivity({
    actor: admin,
    action: "team.invited",
    summary: `${admin.name} invited ${target.name} (${email}) as ${ROLE_LABEL[input.role]}`,
    after: { adminId: target.id, email, role: input.role },
  });
  return {
    message: invite.sent ? `Invite sent to ${email}.` : `Email is not configured; share this one-time link with ${target.name}.`,
    // Shown to the inviting Owner only when no email went out.
    link: invite.sent ? null : invite.link,
  };
}

async function guard(admin: AdminUser, targetId: string, demoting: boolean) {
  const target = await db.adminUser.findUnique({ where: { id: targetId } });
  if (!target) throw notFound("That admin does not exist.");
  if (target.id === admin.id && demoting) throw badRequest("You cannot remove your own Owner access. Ask another Owner.");
  if (demoting && target.role === "owner" && !target.deactivatedAt) {
    const owners = await db.adminUser.count({ where: { role: "owner", deactivatedAt: null } });
    if (owners <= 1) throw conflict("This is the last active Owner. Make someone else an Owner first.");
  }
  return target;
}

export async function changeRole(admin: AdminUser, targetId: string, role: AdminRole, reason: string) {
  const target = await guard(admin, targetId, role !== "owner");
  if (target.role === role) return { message: `${target.name} is already ${ROLE_LABEL[role]}.` };
  await db.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: target.id }, data: { role } });
    await recordActivity(
      {
        actor: admin,
        action: "team.role_changed",
        summary: `${admin.name} changed ${target.name}'s role, ${ROLE_LABEL[target.role]} to ${ROLE_LABEL[role]}`,
        reason,
        before: { role: target.role },
        after: { role },
      },
      tx
    );
  });
  return { message: `${target.name} is now ${ROLE_LABEL[role]}. It applies on their next click.` };
}

/** Deactivate: every session of theirs is revoked in the same transaction, so their next request is refused. */
export async function deactivate(admin: AdminUser, targetId: string, reason: string) {
  if (targetId === admin.id) throw badRequest("You cannot deactivate yourself.");
  const target = await guard(admin, targetId, true);
  if (target.deactivatedAt) throw conflict(`${target.name} is already deactivated.`);
  await db.$transaction(async (tx) => {
    await tx.adminUser.update({
      where: { id: target.id },
      data: { deactivatedAt: new Date(), deactivatedBy: admin.id, inviteTokenHash: null, inviteExpiresAt: null },
    });
    const { count } = await tx.adminSession.updateMany({ where: { adminUserId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await recordActivity(
      {
        actor: admin,
        action: "team.deactivated",
        summary: `${admin.name} deactivated ${target.name}; ${count} ${count === 1 ? "session" : "sessions"} ended`,
        reason,
        after: { adminId: target.id, sessionsEnded: count },
      },
      tx
    );
  });
  return { message: `${target.name} is deactivated. Any open session ended immediately.` };
}

export async function reactivate(admin: AdminUser, targetId: string, reason: string) {
  const target = await db.adminUser.findUnique({ where: { id: targetId } });
  if (!target) throw notFound("That admin does not exist.");
  if (!target.deactivatedAt) throw conflict(`${target.name} is active.`);
  await db.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: target.id }, data: { deactivatedAt: null, deactivatedBy: null } });
    await recordActivity(
      { actor: admin, action: "team.reactivated", summary: `${admin.name} reactivated ${target.name}`, reason, after: { adminId: target.id } },
      tx
    );
  });
  return { message: `${target.name} can sign in again.` };
}

/** For a lost phone: two step goes back to off, and they enrol again at next sign in. */
export async function resetTwoStep(admin: AdminUser, targetId: string, reason: string) {
  const target = await db.adminUser.findUnique({ where: { id: targetId } });
  if (!target) throw notFound("That admin does not exist.");
  if (!target.totpEnabledAt) throw conflict(`${target.name} does not have two step verification on.`);
  await db.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: target.id }, data: { totpSecret: null, totpEnabledAt: null } });
    await tx.adminSession.updateMany({ where: { adminUserId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await recordActivity(
      { actor: admin, action: "team.two_step_reset", summary: `${admin.name} reset two step verification for ${target.name}`, reason, after: { adminId: target.id } },
      tx
    );
  });
  return { message: `Two step verification is off for ${target.name}; they are signed out and set it up again at next sign in.` };
}

export async function resendInvite(admin: AdminUser, targetId: string) {
  const target = await db.adminUser.findUnique({ where: { id: targetId } });
  if (!target || target.deactivatedAt) throw notFound("That admin does not exist.");
  if (target.passwordHash) throw conflict(`${target.name} has already accepted their invite.`);
  const invite = await issueInvite(admin, target);
  await recordActivity({ actor: admin, action: "team.invite_resent", summary: `${admin.name} sent ${target.name} a new invite` });
  return { message: invite.sent ? `New invite sent to ${target.email}.` : `Email is not configured; share this one-time link.`, link: invite.sent ? null : invite.link };
}
