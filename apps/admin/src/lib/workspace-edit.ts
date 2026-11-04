import type { EmailProvider, JobStatus, UserRole } from "@pratibha/prisma";
import { GST_STATES, isValidGstin, isValidPin, stateFromGstin } from "@pratibha/shared";
import type { Permission } from "@/lib/auth/roles";
import { badRequest, conflict, notFound } from "@/lib/http";

/**
 * The rules behind editing a workspace from the panel, kept free of the
 * database so they can be tested on their own. The portal is the source of
 * truth for what a workspace may hold; where it has a rule, this mirrors it
 * (and says where), and where the panel can do something the portal cannot
 * (rename the address, move ownership), the rule is written down here.
 */

/** Who may edit a workspace's contents: Owner and Engineer, not Support. */
export const EDIT_PERMISSION: Permission = "workspace.edit";

/** A row read from a tenant table, checked against the workspace in the URL. */
export function assertInWorkspace<T extends { tenantId: string }>(
  row: T | null | undefined,
  tenantId: string,
  what: string
): T {
  // BYPASSRLS: nothing stops a query from returning another workspace's row,
  // so every id the browser sends is checked against the one in the path.
  if (!row || row.tenantId !== tenantId) throw notFound(`That ${what} is not in this workspace.`);
  return row;
}

/** Only the keys whose values differ, for an activity row's before and after. */
export function changed(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (after[key] === undefined) continue;
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue;
    b[key] = before[key] ?? null;
    a[key] = after[key] ?? null;
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

// ---------------------------------------------------------------------------
// The workspace address
// ---------------------------------------------------------------------------

/**
 * The portal's own top-level routes. A workspace at one of these would be
 * unreachable (the static route wins), so no workspace may take one.
 */
export const RESERVED_SLUGS = [
  "api", "auth", "careers", "j", "login", "logout", "reset-password", "signup", "verify-email", "webhook",
  "admin", "www", "static", "public",
];

export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/** Why an address cannot be used, or null. Uniqueness is the database's to say. */
export function slugProblem(slug: string): string | null {
  // The same rule Create workspace applies.
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return "The address may use lowercase letters, numbers and hyphens, 3 to 40 characters.";
  if (slug.startsWith("-") || slug.endsWith("-")) return "The address cannot start or end with a hyphen.";
  if (RESERVED_SLUGS.includes(slug)) return `/${slug} is one of the portal's own pages. Choose another address.`;
  return null;
}

// ---------------------------------------------------------------------------
// Company profile (mirrors apps/web/src/app/api/[tenant]/company-profile)
// ---------------------------------------------------------------------------

export interface CompanyInput {
  legalName?: string | null;
  addressLine?: string | null;
  city?: string | null;
  pinCode?: string | null;
  billingState?: string | null;
  gstin?: string | null;
  description?: string | null;
}

export interface CompanyLimits {
  legalName: number;
  addressLine: number;
  city: number;
  description: number;
}

/** Blank is cleared, not saved as an empty string. */
const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() ? v.trim() : null);

/** The portal's checks, in its order and with its sentences. Returns the cleaned input. */
export function checkCompanyProfile(input: CompanyInput, limits: CompanyLimits): CompanyInput {
  const data: CompanyInput = {
    legalName: blankToNull(input.legalName),
    addressLine: blankToNull(input.addressLine),
    city: blankToNull(input.city),
    pinCode: blankToNull(input.pinCode),
    billingState: blankToNull(input.billingState),
    gstin: blankToNull(input.gstin),
    description: blankToNull(input.description),
  };
  const tooLong = (value: string | null | undefined, max: number, what: string) => {
    if (value && value.length > max) throw badRequest(`Keep the ${what} under ${max} characters.`);
  };
  tooLong(data.legalName, limits.legalName, "legal company name");
  tooLong(data.addressLine, limits.addressLine, "address line");
  tooLong(data.city, limits.city, "city");
  tooLong(data.description, limits.description, "company description");

  if (data.billingState && !GST_STATES.some((s) => s.name === data.billingState)) {
    throw badRequest("Choose a state from the list.");
  }
  if (data.pinCode && !isValidPin(data.pinCode)) throw badRequest("A PIN code is six digits.");
  if (data.gstin) {
    data.gstin = data.gstin.toUpperCase();
    if (!isValidGstin(data.gstin)) {
      throw badRequest("That GSTIN is not in the right format. It should be 15 characters, e.g. 07AASFP3808P2ZF.");
    }
  }
  return data;
}

/** The portal's persistent warning when the GSTIN and the state disagree; it saves anyway. */
export function gstinWarning(gstin: string | null | undefined, state: string | null | undefined): string | null {
  if (!gstin || !state) return null;
  const declared = stateFromGstin(gstin);
  if (!declared || declared === state) return null;
  return `This GSTIN starts ${gstin.slice(0, 2)}, which is ${declared}, but the state says ${state}. One of the two is wrong, and invoices will charge the wrong tax until it is fixed.`;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const MEMBER_ROLES: UserRole[] = ["owner", "admin", "reviewer", "viewer"];

export const MEMBER_ROLE_LABEL: Record<UserRole, string> = {
  owner: "Owner",
  admin: "Admin",
  reviewer: "Reviewer",
  viewer: "Viewer",
};

export interface MemberLite {
  id: string;
  email: string;
  role: UserRole;
  removedAt: Date | null;
  authProviderId: string | null;
}

function activeMember<T extends MemberLite>(members: T[], userId: string): T {
  const member = members.find((m) => m.id === userId && !m.removedAt);
  if (!member) throw notFound("That member is not in this workspace.");
  return member;
}

/**
 * A role change that is not about ownership. A workspace has exactly one
 * owner, so becoming or ceasing to be the owner only happens by transfer.
 */
export function assertRoleChange<T extends MemberLite>(members: T[], userId: string, role: UserRole): T {
  const member = activeMember(members, userId);
  if (role === "owner") {
    throw conflict("A workspace has exactly one owner. Use Transfer ownership to make someone the owner.");
  }
  if (member.role === "owner") {
    throw conflict("The owner's role changes only by transferring ownership to another member.");
  }
  if (member.role === role) throw conflict(`${member.email} is already ${MEMBER_ROLE_LABEL[role]}.`);
  return member;
}

/**
 * Hand the workspace to another member. Every other owner (normally one) steps
 * down to Admin, so exactly one owner is left. The new owner must be able to
 * sign in: a workspace whose only owner has never joined has nobody to run it,
 * and Sign in as has nobody to sign in as.
 */
export function planOwnershipTransfer<T extends MemberLite>(members: T[], userId: string): { target: T; demote: T[] } {
  const target = activeMember(members, userId);
  const owners = members.filter((m) => !m.removedAt && m.role === "owner");
  if (target.role === "owner" && owners.length === 1) throw conflict(`${target.email} is already the owner.`);
  if (!target.authProviderId) {
    throw conflict(`${target.email} has not joined yet. Send them an invite, and transfer ownership once they have signed in.`);
  }
  return { target, demote: owners.filter((m) => m.id !== target.id) };
}

/** Removal never leaves a workspace without its owner. */
export function assertRemovable<T extends MemberLite>(members: T[], userId: string): T {
  const member = activeMember(members, userId);
  if (member.role === "owner") {
    throw conflict("The owner cannot be removed. Transfer ownership to another member first.");
  }
  return member;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** What the panel may move a job to. Draft means never published; nothing goes back to it. */
export const SETTABLE_JOB_STATUSES: JobStatus[] = ["open", "paused", "closed"];

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  draft: "Draft",
  open: "Open",
  paused: "Paused",
  closed: "Closed",
};

/** Statuses that count against the plan's job limit (apps/web/src/lib/billing.ts). */
const ACTIVE: JobStatus[] = ["open", "paused"];

export function assertJobStatusChange(input: {
  from: JobStatus;
  to: JobStatus;
  archived: boolean;
  hasApprovedDescription: boolean;
  activeJobs: number;
  jobLimit: number | null;
}) {
  const { from, to } = input;
  if (input.archived) throw conflict("This job is archived. Restore it before changing it.");
  if (!SETTABLE_JOB_STATUSES.includes(to)) throw badRequest("A job can be set to open, paused or closed.");
  if (from === to) return;
  // The portal's publish step refuses the same thing.
  if (to === "open" && !input.hasApprovedDescription) {
    throw conflict("This job has no approved description yet. The customer approves one in JD Studio before it can open.");
  }
  if (ACTIVE.includes(to) && !ACTIVE.includes(from) && input.jobLimit !== null && input.activeJobs >= input.jobLimit) {
    throw conflict(`Active role limit reached (${input.activeJobs}/${input.jobLimit}). Change the plan, or close another job first.`);
  }
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

export const PROVIDER_LABEL: Record<EmailProvider, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  imap: "IMAP",
  forward_alias: "Forwarding",
};

export function assertMailboxUpdate(
  connection: { provider: EmailProvider },
  next: { defaultJobId?: string | null }
) {
  // The portal's create rule: a forwarding address with nowhere to file mail
  // would accept applications and drop them.
  if (connection.provider === "forward_alias" && next.defaultJobId === null) {
    throw badRequest("A forwarding address needs a destination job, or the mail it receives is dropped.");
  }
}

// ---------------------------------------------------------------------------
// Interview settings (mirrors apps/web/src/app/api/[tenant]/interview-protocols)
// ---------------------------------------------------------------------------

/** Fields gated by `gate.interview_tuning`; length and question counts are on every plan. */
export const TUNING_FIELDS = [
  "screenNotice", "screenSalary", "screenReasonLeaving", "screenGaps", "screenLocation",
  "screenWorkMode", "screenTravel", "screenReference", "shareBand", "mismatchAction",
  "customQuestions", "difficulty", "focusAreas", "instructionText",
] as const;

const TIERS = ["starter", "growth", "scale"];

/** The portal's planClearsGate, word for word. */
export function planClearsGate(planKey: string | null | undefined, gate: string): boolean {
  if (gate === "all") return true;
  const need = TIERS.indexOf(gate);
  const have = TIERS.indexOf(planKey ?? "");
  return need === -1 || (have !== -1 && have >= need);
}

/** Tuning fields this save would change, against the saved row. */
export function tuningChanges(existing: Record<string, unknown> | null, data: Record<string, unknown>): string[] {
  const base = existing ?? {};
  return TUNING_FIELDS.filter(
    (f) => data[f] !== undefined && JSON.stringify(data[f]) !== JSON.stringify(base[f] ?? undefined)
  );
}

/**
 * The database CHECK is max >= min on the saved row. The shared schema only
 * compares the two when both are sent, so the merged pair is checked here and
 * refused with a sentence instead of a constraint error.
 */
export function assertQuestionBounds(min: number, max: number) {
  if (max < min) throw badRequest("Maximum questions cannot be lower than the minimum");
}
