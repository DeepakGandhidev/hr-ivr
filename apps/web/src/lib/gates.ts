import { ForbiddenError, logAuthzDenial, NotFoundError, ValidationError } from "@pratibha/shared";
import { adminPrisma } from "@pratibha/prisma";
import type { PrismaClient } from "@pratibha/prisma";

export interface SendInvitesInput {
  candidateIds?: string[];
  /**
   * Send again to a candidate who already has an invite under the current
   * approval. Off by default: a "Request interview" button is one double-click
   * away from mailing a candidate twice, and the person on the other end reads
   * that as the company being disorganised. Re-sending stays possible because a
   * genuine resend request is a normal thing for a recruiter to want.
   */
  resend?: boolean;
}

export interface OutreachGateActor {
  tenantId: string;
  userId: string;
}

export async function verifyOutreachGate(
  tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">,
  shortlistId: string,
  input: SendInvitesInput,
  actor: OutreachGateActor
): Promise<{
  shortlist: { id: string; job: { title: string } };
  approval: { id: string; snapshot: Array<{ candidateId: string }> };
  items: Array<{ candidateId: string; candidate: { id: string; email: string | null; name: string | null } }>;
}> {
  const shortlist = await tx.shortlist.findUnique({
    where: { id: shortlistId },
    include: {
      job: true,
      items: {
        where: { OR: [{ finalState: null }, { finalState: "approved" }] },
        include: { candidate: true },
      },
      approvals: { orderBy: { approvedAt: "desc" }, take: 1 },
    },
  });

  if (!shortlist) {
    throw new NotFoundError("Shortlist not found");
  }

  const approval = shortlist.approvals[0];
  if (!approval) {
    throw new ForbiddenError("Shortlist must be approved before sending invites");
  }

  const snapshot = (approval.snapshot as unknown as Array<{ candidateId: string }>) ?? [];
  const approvedIds = new Set(snapshot.map((s) => s.candidateId));
  const itemIds = new Set(shortlist.items.map((i) => i.candidateId));

  const requested = input.candidateIds;
  const candidateIds = requested ?? shortlist.items.map((i) => i.candidateId);

  // Every explicitly requested candidate must be on this shortlist AND inside
  // the approval snapshot. Filtering unknown ids away instead of rejecting them
  // made this endpoint fail open: a request naming a candidate who was never
  // approved returned 200 having sent nothing, which reads as success to any
  // caller probing the gate. §6 requires a 403 and an audit entry.
  const denied = (requested ?? []).filter((id) => !itemIds.has(id) || !approvedIds.has(id));

  if (denied.length) {
    const reason = `Attempted outreach to candidate(s) outside approval ${approval.id}: ${denied.join(", ")}`;
    // Written on a separate connection: the ForbiddenError below rolls back the
    // caller's transaction, which would take this entry with it.
    //
    // A logging failure must not replace the denial with a 500. The send is
    // blocked either way, but the recruiter clicking "Request interview" needs
    // to be told the candidate is outside the approval — an opaque database
    // error reads as "try again", which is the wrong advice. Mirrors
    // recordAuthzDenial() in authz.ts, which guards the same write for the same
    // reason.
    try {
      await logAuthzDenial(
        adminPrisma as unknown as PrismaClient,
        actor.tenantId,
        actor.userId,
        "outreach.send",
        "shortlist",
        shortlistId,
        reason
      );
    } catch (error) {
      console.error("Failed to write outreach denial audit entry", error);
    }
    throw new ForbiddenError(reason);
  }

  const items = shortlist.items.filter((i) => candidateIds.includes(i.candidateId));

  for (const item of items) {
    if (!approvedIds.has(item.candidateId)) {
      throw new ForbiddenError(`Candidate ${item.candidateId} is not in the approved shortlist snapshot`);
    }
  }

  return { shortlist, approval: { ...approval, snapshot }, items };
}

export function validateSendInvitesBody(body: unknown): SendInvitesInput {
  if (body === null || typeof body !== "object") {
    throw new ValidationError("Invalid send invites payload");
  }
  const { candidateIds, resend } = body as { candidateIds?: unknown; resend?: unknown };
  if (candidateIds !== undefined && !Array.isArray(candidateIds)) {
    throw new ValidationError("candidateIds must be an array");
  }
  if (resend !== undefined && typeof resend !== "boolean") {
    throw new ValidationError("resend must be a boolean");
  }
  return { candidateIds: candidateIds as string[] | undefined, resend: resend === true };
}
