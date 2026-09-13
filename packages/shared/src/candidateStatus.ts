import type { PrismaClient } from '@pratibha/prisma';
import { writeAuditLog } from './audit.js';

/**
 * Pipeline position for a candidate.
 *
 * Kept as one ordered vocabulary rather than a set of booleans, because the
 * question every screen asks is "where is this person now", and a board view
 * added later has to read the same answer.
 */
export const CANDIDATE_STATUSES = [
  'inbox',
  'screened',
  'shortlisted',
  'interviewed',
  'advance_stage',
  'hired',
  'rejected',
] as const;

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** Human labels. The UI never builds these from the enum by string munging. */
export const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  inbox: 'Inbox',
  screened: 'Screened',
  shortlisted: 'Shortlisted',
  interviewed: 'Interviewed',
  advance_stage: 'Advance Stage',
  hired: 'Hired',
  rejected: 'Rejected',
};

/**
 * The four the system reaches on its own, in the order events happen.
 *
 * `rank` is only meaningful within this list: it is what stops a late-arriving
 * event from dragging someone backwards (a re-screen must not pull an already
 * shortlisted candidate back to `screened`).
 */
const AUTOMATIC_ORDER: CandidateStatus[] = ['inbox', 'screened', 'shortlisted', 'interviewed'];

/**
 * Judgements. Nothing in the system infers these - a person decides them, and
 * automatic progression must never overwrite one. Somebody marked Hired does
 * not go back to Interviewed because a report finished writing.
 */
const MANUAL_ONLY: CandidateStatus[] = ['advance_stage', 'hired', 'rejected'];

export function isManualOnlyStatus(status: CandidateStatus): boolean {
  return MANUAL_ONLY.includes(status);
}

function automaticRank(status: CandidateStatus): number {
  return AUTOMATIC_ORDER.indexOf(status);
}

/**
 * Whether an automatic event may move a candidate from `current` to `next`.
 *
 * Two rules, both of them about not destroying information:
 *  - a manual status is never overwritten automatically;
 *  - automatic progress only moves forward.
 */
export function canAutoAdvance(current: CandidateStatus, next: CandidateStatus): boolean {
  if (isManualOnlyStatus(current)) return false;
  const from = automaticRank(current);
  const to = automaticRank(next);
  if (to === -1) return false;
  return to > from;
}

type StatusDb = Pick<PrismaClient, 'candidate' | 'auditLog'>;

export interface AdvanceArgs {
  tenantId: string;
  candidateId: string;
  to: CandidateStatus;
  /** user id for a person, or 'system' for an automatic transition. */
  actor?: string;
  reason?: string;
}

/**
 * Move a candidate forward automatically, if the rules allow it.
 *
 * Safe to call unconditionally at the point the event happens - it reads the
 * current status and does nothing when the move is not allowed, so callers do
 * not each re-implement the ordering. Returns the status in force afterwards.
 *
 * Deliberately not throwing when the move is refused: these run alongside the
 * real work (a screening, a shortlist row), and a candidate already further
 * down the pipeline is a normal outcome, not a failure of the thing that
 * called it.
 */
export async function advanceCandidateStatus(
  db: StatusDb,
  { tenantId, candidateId, to, actor = 'system', reason }: AdvanceArgs
): Promise<CandidateStatus | null> {
  const candidate = await db.candidate.findUnique({
    where: { id: candidateId },
    select: { status: true },
  });
  if (!candidate) return null;

  const current = candidate.status as CandidateStatus;
  if (!canAutoAdvance(current, to)) return current;

  await db.candidate.update({ where: { id: candidateId }, data: { status: to } });

  await writeAuditLog(db as PrismaClient, {
    tenantId,
    actor,
    action: 'candidate.status',
    entity: 'candidate',
    entityId: candidateId,
    before: { status: current },
    after: { status: to },
    reason,
  });

  return to;
}

/**
 * Set a status because a person said so.
 *
 * Any status may be set from any other, including backwards: the recruiter is
 * the authority on where someone stands, and refusing a correction would just
 * mean the field stops matching reality. The audit entry is the record of who
 * decided it.
 *
 * This writes `status` and nothing else. It creates no shortlist row, no
 * approval and no outreach - setting someone to `shortlisted` here is a label,
 * not a decision to contact them, and the approval gate is untouched by it.
 */
export async function setCandidateStatusManually(
  db: StatusDb,
  { tenantId, candidateId, to, actor, reason }: AdvanceArgs & { actor: string }
): Promise<{ from: CandidateStatus; to: CandidateStatus } | null> {
  const candidate = await db.candidate.findUnique({
    where: { id: candidateId },
    select: { status: true },
  });
  if (!candidate) return null;

  const from = candidate.status as CandidateStatus;
  if (from === to) return { from, to };

  await db.candidate.update({ where: { id: candidateId }, data: { status: to } });

  await writeAuditLog(db as PrismaClient, {
    tenantId,
    actor,
    action: 'candidate.status',
    entity: 'candidate',
    entityId: candidateId,
    before: { status: from },
    after: { status: to },
    reason,
  });

  return { from, to };
}
