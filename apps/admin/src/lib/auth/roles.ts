import type { AdminRole } from "@pratibha/prisma";

/**
 * Who may do what in the panel, enforced at the API.
 *
 * The UI reads the same table to disable a control and say why, but the
 * refusal that matters is the server's: a Support token calling the publish
 * endpoint is refused there, whatever the page did or did not render.
 *
 *   Owner     everything.
 *   Engineer  sees everything, edits Platform settings and AI prompts, but
 *             cannot publish pricing, delete workspaces, manage admins, or
 *             change Owner-only settings (API keys, billing, security).
 *   Owner and Engineer both edit and publish the website (Website).
 *   Support   can view, Sign in as with a reason, and grant goodwill minutes up
 *             to the configured cap. Nothing else.
 */
export const PERMISSIONS = [
  "view",
  "workspace.create",
  "workspace.change_plan",
  "workspace.grant_goodwill",
  "workspace.add_pack",
  "workspace.sign_in_as",
  "workspace.suspend",
  "workspace.delete",
  "workspace.members",
  "workspace.edit",
  "pricing.edit",
  "pricing.publish",
  "coupons.manage",
  "payments.record",
  "payments.refund",
  "payments.export",
  "calls.block",
  "settings.edit",
  "settings.owner",
  "prompts.edit",
  "team.manage",
  "website.edit",
  "website.publish",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ENGINEER_DENIED: Permission[] = ["pricing.publish", "workspace.delete", "team.manage", "settings.owner"];
const SUPPORT_ALLOWED: Permission[] = ["view", "workspace.sign_in_as", "workspace.grant_goodwill"];

export function can(role: AdminRole, permission: Permission): boolean {
  switch (role) {
    case "owner":
      return true;
    case "engineer":
      return !ENGINEER_DENIED.includes(permission);
    case "support":
      return SUPPORT_ALLOWED.includes(permission);
    default:
      return false;
  }
}

export const ROLE_LABEL: Record<AdminRole, string> = {
  owner: "Owner",
  engineer: "Engineer",
  support: "Support",
};

/** The sidebar's second line: "Admin owner". */
export const ROLE_TITLE: Record<AdminRole, string> = {
  owner: "Admin owner",
  engineer: "Engineer",
  support: "Support",
};

/**
 * The sentence shown when a role cannot do something, on the page and in the
 * API's refusal, so the two always say the same thing.
 */
export function refusalReason(role: AdminRole, permission: Permission): string {
  const who = ROLE_LABEL[role];
  switch (permission) {
    case "pricing.publish":
      return `${who} cannot publish pricing. Only an Owner can.`;
    case "pricing.edit":
      return `Plans are read only for ${who}: only an Owner or Engineer can edit them, and only an Owner can publish.`;
    case "workspace.delete":
      return `${who} cannot delete workspaces. Only an Owner can, and a second admin must approve.`;
    case "team.manage":
      return `${who} cannot manage admins. Only an Owner can.`;
    case "settings.edit":
      return `${who} cannot change Platform settings. Only an Owner or Engineer can.`;
    case "workspace.edit":
      return `${who} cannot edit workspace details. Only an Owner or Engineer can.`;
    case "settings.owner":
      return `${who} cannot change API keys, billing or security settings. Only an Owner can.`;
    case "website.edit":
    case "website.publish":
      return `${who} cannot change the website. Only an Owner or Engineer can.`;
    case "prompts.edit":
      return `${who} cannot change AI prompts. Only an Owner or Engineer can.`;
    default:
      return `${who} cannot do this. Support can view, sign in as a workspace with a reason, and grant goodwill minutes up to the cap.`;
  }
}
