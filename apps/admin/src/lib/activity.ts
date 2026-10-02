import type { Prisma, AdminUser, ActorType } from "@pratibha/prisma";
import { db, type Db } from "@/lib/db";

/**
 * One row in the append-only activity log.
 *
 * Written inside the same transaction as the change it records wherever there
 * is one, so a change without its row (or a row without its change) cannot
 * happen. Every sensitive action passes a typed reason; the API refuses the
 * action before it gets here if the reason is missing.
 */
export interface ActivityInput {
  actorType?: ActorType;
  actor?: Pick<AdminUser, "id" | "name"> | null;
  action: string;
  summary: string;
  workspace?: { id: string; name: string } | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export async function recordActivity(input: ActivityInput, client: Db = db) {
  return client.activityLog.create({
    data: {
      actorType: input.actorType ?? (input.actor ? "admin" : "system"),
      actorId: input.actor?.id ?? null,
      actorName: input.actor?.name ?? null,
      action: input.action,
      summary: input.summary,
      targetWorkspaceId: input.workspace?.id ?? null,
      targetWorkspaceName: input.workspace?.name ?? null,
      reason: input.reason ?? null,
      before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/** Actions that count as billing, for the Activity page's Billing filter. */
export const BILLING_ACTION_PREFIXES = [
  "payment.",
  "subscription.",
  "workspace.plan_changed",
  "workspace.minutes_granted",
  "workspace.pack_added",
  "pricing.",
  "coupon.",
];

export const SIGN_IN_AS_ACTION = "workspace.signed_in_as";
