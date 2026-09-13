import { AVERAGE_INTERVIEW_MINUTES } from './constants.js';

/**
 * What a call costs, in minutes.
 *
 * The clock starts at the FIRST QUESTION, not when the phone is answered. The
 * greeting, the AI disclosure, identity checks, language choice and both
 * consent steps are not billed — that is what the Interview settings screen
 * tells customers, and it is what we advertise, so it is enforced here rather
 * than left to each caller to remember.
 *
 * Rounded up to the whole minute: a 61-second interview costs two.
 *
 * Returns 0 when no question was ever reached. A call that never got past
 * consent has no billable content, however long the line was open — which is
 * also why this cannot be computed from the call's own duration.
 */
export function billableMinutes(
  firstQuestionAt: Date | string | null | undefined,
  endedAt: Date | string | null | undefined
): number {
  if (!firstQuestionAt || !endedAt) return 0;

  const start = new Date(firstQuestionAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;

  const ms = end - start;
  if (ms <= 0) return 0;

  return Math.ceil(ms / 60_000);
}

/**
 * Whether a call is billed at all.
 *
 * Unchanged in spirit from the per-interview rule it replaces: an unrecognised
 * caller, an out-of-window call-back, a declined consent and a mid-call drop
 * are never charged for. The unit changed; who is exempt did not.
 *
 * `minutes` is included in the test so a completed call that somehow reached no
 * question cannot bill zero minutes and still consume a billing event.
 */
export function isBillableCall({
  status,
  recognised,
  producesReport,
  tenantId,
  minutes,
}: {
  status: string | null | undefined;
  recognised: boolean | null | undefined;
  producesReport: boolean | null | undefined;
  tenantId: string | null | undefined;
  minutes: number;
}): boolean {
  return Boolean(
    producesReport && status === 'completed' && recognised && tenantId && minutes > 0
  );
}

/**
 * Minutes translated back into the unit customers think in.
 *
 * Shown as "roughly", always, because it is an estimate built on the average
 * interview length rather than on anything that has happened. Presenting it as
 * exact would invite exactly the surprise-overage complaint the meter exists to
 * prevent.
 */
export function approximateInterviews(
  minutes: number,
  averageMinutes: number = AVERAGE_INTERVIEW_MINUTES
): number {
  if (minutes <= 0 || averageMinutes <= 0) return 0;
  return Math.floor(minutes / averageMinutes);
}

export interface QuotaState {
  used: number;
  limit: number | null;
  remaining: number | null;
  /** 0–1, or null when the plan is unmetered. */
  fraction: number | null;
  /** null, 'warning' at 80%, 'exhausted' at 100%. */
  level: null | 'warning' | 'exhausted';
}

/**
 * Where a tenant stands against its minute quota.
 *
 * One function so the sidebar meter, the warnings and the enforcement points
 * all read the same thresholds. They drifted apart when each screen decided for
 * itself what "nearly out" meant.
 */
export function quotaState(used: number, limit: number | null): QuotaState {
  if (limit === null) {
    return { used, limit: null, remaining: null, fraction: null, level: null };
  }

  const remaining = Math.max(0, limit - used);
  const fraction = limit > 0 ? used / limit : 1;

  return {
    used,
    limit,
    remaining,
    fraction,
    level: fraction >= 1 ? 'exhausted' : fraction >= 0.8 ? 'warning' : null,
  };
}
