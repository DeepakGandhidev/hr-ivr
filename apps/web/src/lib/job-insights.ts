import { DEFAULT_SCREENING_THRESHOLD, SUPPORTED_LANGUAGES } from "@pratibha/shared";
import type { TenantTransactionClient } from "@/lib/authz";
import { describeCallWindows } from "@/lib/format";

/**
 * The state of hiring for a role, as the Jobs list, the job hub and its tabs
 * all show it.
 *
 * One module so the numbers cannot disagree between screens: a card, the hub's
 * funnel strip, the tab counts and the Overview's funnel all count the same
 * things the same way (see FUNNEL_WHERE).
 */

type Tx = TenantTransactionClient;

// ---------------------------------------------------------------------------
// Funnel definitions — shared with the Overview
// ---------------------------------------------------------------------------

/** Scope a funnel count to one job, several jobs, or a whole tenant. */
export type FunnelScope = { jobId: string } | { jobIds: string[] } | { tenantId: string };

function candidateScope(scope: FunnelScope) {
  if ("jobId" in scope) return { jobId: scope.jobId };
  if ("jobIds" in scope) return { jobId: { in: scope.jobIds } };
  return { tenantId: scope.tenantId };
}

/**
 * What each stage counts. Candidates, not rows: a re-screened candidate is one
 * screened candidate, not two.
 *
 *  applications  every candidate filed against the role
 *  screened      candidates with at least one screening
 *  shortlisted   candidates screening suggested for the shortlist
 *  interviewed   interview reports: a call that happened AND produced a report,
 *                the same bar the worker uses to mark someone interviewed
 *  recommended   reports recommending yes or strong yes
 */
export const FUNNEL_WHERE = {
  applications: (s: FunnelScope) => candidateScope(s),
  screened: (s: FunnelScope) => ({ ...candidateScope(s), screenings: { some: {} } }),
  shortlisted: (s: FunnelScope) => ({ ...candidateScope(s), screenings: { some: { verdict: "shortlist" as const } } }),
  interviewed: (s: FunnelScope) => ({ interviewCall: { candidate: candidateScope(s) } }),
  recommended: (s: FunnelScope) => ({
    interviewCall: { candidate: candidateScope(s) },
    recommendation: { in: ["strong_yes" as const, "yes" as const] },
  }),
};

/** Shortlist rows waiting on a human: on an unapproved shortlist, not removed. */
function awaitingApprovalWhere(jobIds: string[]) {
  return {
    finalState: null,
    removedBy: null,
    shortlist: { jobId: { in: jobIds }, status: { in: ["draft" as const, "awaiting_approval" as const] } },
  };
}

export interface JobCounts {
  applications: number;
  screened: number;
  shortlisted: number;
  /** Candidates on an unapproved shortlist: the Shortlist tab's count. */
  awaitingApproval: number;
  interviewed: number;
  recommended: number;
  /** CVs that arrived with no phone number: Pratibha cannot invite them. */
  missingPhone: number;
}

const EMPTY_COUNTS: JobCounts = {
  applications: 0,
  screened: 0,
  shortlisted: 0,
  awaitingApproval: 0,
  interviewed: 0,
  recommended: 0,
  missingPhone: 0,
};

/** Counts for many jobs in a fixed number of queries, whatever the job count. */
export async function countsForJobs(tx: Tx, jobIds: string[]): Promise<Map<string, JobCounts>> {
  const out = new Map<string, JobCounts>(jobIds.map((id) => [id, { ...EMPTY_COUNTS }]));
  if (jobIds.length === 0) return out;
  const scope: FunnelScope = { jobIds };

  const [applications, screened, shortlisted, missingPhone, waiting, reports] = await Promise.all([
    tx.candidate.groupBy({ by: ["jobId"], where: FUNNEL_WHERE.applications(scope), _count: { _all: true } }),
    tx.candidate.groupBy({ by: ["jobId"], where: FUNNEL_WHERE.screened(scope), _count: { _all: true } }),
    tx.candidate.groupBy({ by: ["jobId"], where: FUNNEL_WHERE.shortlisted(scope), _count: { _all: true } }),
    tx.candidate.groupBy({
      by: ["jobId"],
      where: { ...candidateScope(scope), OR: [{ noPhone: true }, { phoneE164: null }] },
      _count: { _all: true },
    }),
    tx.shortlistItem.findMany({
      where: awaitingApprovalWhere(jobIds),
      select: { candidateId: true, shortlist: { select: { jobId: true } } },
    }),
    tx.assessmentReport.findMany({
      where: FUNNEL_WHERE.interviewed(scope),
      select: { recommendation: true, interviewCall: { select: { candidate: { select: { jobId: true } } } } },
    }),
  ]);

  const put = (rows: Array<{ jobId: string; _count: { _all: number } }>, key: keyof JobCounts) => {
    for (const r of rows) {
      const c = out.get(r.jobId);
      if (c) c[key] = r._count._all;
    }
  };
  put(applications, "applications");
  put(screened, "screened");
  put(shortlisted, "shortlisted");
  put(missingPhone, "missingPhone");

  // Distinct candidates: one person can sit on two draft shortlists after a
  // re-approval, and is still one decision waiting.
  const waitingByJob = new Map<string, Set<string>>();
  for (const w of waiting) {
    const set = waitingByJob.get(w.shortlist.jobId) ?? new Set<string>();
    set.add(w.candidateId);
    waitingByJob.set(w.shortlist.jobId, set);
  }
  for (const [jobId, set] of Array.from(waitingByJob.entries())) {
    const c = out.get(jobId);
    if (c) c.awaitingApproval = set.size;
  }

  for (const r of reports) {
    const c = out.get(r.interviewCall.candidate.jobId);
    if (!c) continue;
    c.interviewed += 1;
    if (r.recommendation === "yes" || r.recommendation === "strong_yes") c.recommended += 1;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Publish state
// ---------------------------------------------------------------------------

/**
 *  live         published, and no JD version saved since
 *  live_edited  a JD version was saved after the last publish, so the public
 *               page shows an older one
 *  draft        never published, or not open
 *  archived     only ever shown under the Archived tab
 */
export type PublishState = "live" | "live_edited" | "draft" | "archived";

export interface PublishInfo {
  state: PublishState;
  /** Last publish, which is what "up to date" is measured against. */
  publishedAt: string | null;
  /** First publish: when the role went public, for "open N days". */
  firstPublishedAt: string | null;
  /** When the JD changed after the last publish, for the republish strip. */
  jdChangedAt: string | null;
  latestVersion: { id: string; version: number; approved: boolean; createdAt: string } | null;
}

interface PublishInputs {
  status: string;
  deletedAt: Date | null;
  careersPost: { status: string; postedAt: Date | null; createdAt: Date } | null;
  latestJd: { id: string; version: number; approvedAt: Date | null; createdAt: Date } | null;
}

/** Derived from timestamps, so it cannot drift out of step with the data. */
export function publishStateOf(input: PublishInputs): PublishInfo {
  const latestVersion = input.latestJd
    ? {
        id: input.latestJd.id,
        version: input.latestJd.version,
        approved: Boolean(input.latestJd.approvedAt),
        createdAt: input.latestJd.createdAt.toISOString(),
      }
    : null;

  const posted =
    input.careersPost && input.careersPost.status === "posted" && input.careersPost.postedAt
      ? input.careersPost
      : null;

  if (input.deletedAt) {
    return { state: "archived", publishedAt: posted?.postedAt?.toISOString() ?? null, firstPublishedAt: null, jdChangedAt: null, latestVersion };
  }

  // The public page only serves open roles, so a posting on a role that is not
  // open is not live whatever the post row says.
  if (!posted || input.status !== "open") {
    return { state: "draft", publishedAt: null, firstPublishedAt: null, jdChangedAt: null, latestVersion };
  }

  const publishedAt = posted.postedAt!;
  const changed = input.latestJd && input.latestJd.createdAt > publishedAt ? input.latestJd.createdAt : null;

  return {
    state: changed ? "live_edited" : "live",
    publishedAt: publishedAt.toISOString(),
    // The post row is created on first publish; postedAt moves on republish.
    // The earlier of the two is when the role first went public.
    firstPublishedAt: (posted.createdAt < publishedAt ? posted.createdAt : publishedAt).toISOString(),
    jdChangedAt: changed ? changed.toISOString() : null,
    latestVersion,
  };
}

/** Publish inputs for many jobs at once. */
export async function publishInputsForJobs(
  tx: Tx,
  jobs: Array<{ id: string; status: string; deletedAt: Date | null }>
): Promise<Map<string, PublishInfo>> {
  const ids = jobs.map((j) => j.id);
  const [posts, latest] = await Promise.all([
    tx.jobPost.findMany({
      where: { jobId: { in: ids }, channel: "careers_page" },
      orderBy: { createdAt: "asc" },
      select: { jobId: true, status: true, postedAt: true, createdAt: true },
    }),
    tx.jobDescription.findMany({
      where: { jobId: { in: ids } },
      orderBy: [{ jobId: "asc" }, { version: "desc" }],
      distinct: ["jobId"],
      select: { id: true, jobId: true, version: true, approvedAt: true, createdAt: true },
    }),
  ]);

  const postByJob = new Map(posts.map((p) => [p.jobId, p]));
  const jdByJob = new Map(latest.map((d) => [d.jobId, d]));
  return new Map(
    jobs.map((j) => [
      j.id,
      publishStateOf({
        status: j.status,
        deletedAt: j.deletedAt,
        careersPost: postByJob.get(j.id) ?? null,
        latestJd: jdByJob.get(j.id) ?? null,
      }),
    ])
  );
}

// ---------------------------------------------------------------------------
// The one thing a person should do next
// ---------------------------------------------------------------------------

export type AttentionKind = "approval" | "republish" | "missing_phone" | "not_published";

export interface Attention {
  kind: AttentionKind;
  count?: number;
  /** ISO date for the republish strip, formatted where it is read. */
  date?: string | null;
  /** Link label and the tab that resolves it. */
  action: string;
  tab: "shortlist" | "publish" | "candidates?missing=phone";
}

/**
 * Priority, highest first: a shortlist waiting on approval, then a stale public
 * page, then CVs nobody can invite, then a role nobody can see. One strip per
 * card, so the most urgent human task is not buried under three others.
 */
export function attentionFor(counts: JobCounts, publish: PublishInfo): Attention | null {
  if (publish.state === "archived") return null;
  if (counts.awaitingApproval > 0) {
    return { kind: "approval", count: counts.awaitingApproval, action: "Review", tab: "shortlist" };
  }
  if (publish.state === "live_edited") {
    return { kind: "republish", date: publish.jdChangedAt, action: "Republish", tab: "publish" };
  }
  if (counts.missingPhone > 0) {
    return { kind: "missing_phone", count: counts.missingPhone, action: "Add numbers", tab: "candidates?missing=phone" };
  }
  if (publish.state === "draft") {
    return { kind: "not_published", action: "Publish", tab: "publish" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Interview setup, after overrides
// ---------------------------------------------------------------------------

/** What the worker falls back to when neither the job nor the tenant set one. */
const PROTOCOL_FALLBACK = { durationMinutes: 10, difficulty: "moderate", focusAreas: [] as string[] };

const LANGUAGE_NAMES: Record<string, string> = { en: "English", hi: "Hindi", hinglish: "Hinglish" };

export interface InterviewSetup {
  durationMinutes: number;
  difficulty: string;
  focusAreas: string[];
  languages: string[];
  callWindow: string;
  /** Whether the job has its own settings or inherits the workspace's. */
  source: "job" | "workspace" | "default";
}

/**
 * The settings a call for this job actually runs with: the job's own protocol,
 * else the workspace default, else the worker's built-in fallback — the same
 * precedence the worker applies when it looks the caller up.
 */
export async function interviewSetupFor(tx: Tx, tenantId: string, jobId: string): Promise<InterviewSetup> {
  const [jobProtocol, tenantProtocol, windows] = await Promise.all([
    tx.interviewProtocol.findUnique({ where: { tenantId_jobId: { tenantId, jobId } } }),
    tx.interviewProtocol.findFirst({ where: { tenantId, jobId: null } }),
    tx.callWindow.findMany({ where: { jobId }, orderBy: { createdAt: "desc" } }),
  ]);
  const p = jobProtocol ?? tenantProtocol;
  const focus = Array.isArray(p?.focusAreas) ? (p!.focusAreas as unknown[]).map(String).filter(Boolean) : [];

  return {
    durationMinutes: p?.durationMinutes ?? PROTOCOL_FALLBACK.durationMinutes,
    difficulty: p?.difficulty ?? PROTOCOL_FALLBACK.difficulty,
    focusAreas: focus,
    languages: SUPPORTED_LANGUAGES.map((l) => LANGUAGE_NAMES[l] ?? l),
    callWindow: describeCallWindows(windows),
    source: jobProtocol ? "job" : tenantProtocol ? "workspace" : "default",
  };
}

// ---------------------------------------------------------------------------
// Thresholds and plan flags, from the database
// ---------------------------------------------------------------------------

export interface DbConfig {
  /** Interview vs recommendation score difference that earns a "gap" badge. */
  scoreGapThreshold: number;
  /**
   * Whether job-portal posts (Naukri, LinkedIn) are available on this plan.
   * Read from plans.features.portalPosts. Unset means available: the plan
   * gating decision is still open, and until it is made the portal keeps
   * today's behaviour. Setting the flag to false on a plan row gates it with
   * no code change.
   */
  portalPosts: boolean;
}

const DB_CONFIG_DEFAULTS: DbConfig = { scoreGapThreshold: 2.0, portalPosts: true };

/**
 * UI thresholds and toggles live on the tenant's plan row (plans.features),
 * which is platform configuration in the database, so they can be tuned per
 * plan without a deploy.
 */
export async function dbConfigFor(tx: Tx, planId: string): Promise<DbConfig> {
  const plan = await tx.plan.findUnique({ where: { id: planId }, select: { features: true } }).catch(() => null);
  const f = (plan?.features ?? {}) as Record<string, unknown>;
  const gap = Number(f.reportScoreGapThreshold);
  return {
    scoreGapThreshold: Number.isFinite(gap) && gap > 0 ? gap : DB_CONFIG_DEFAULTS.scoreGapThreshold,
    portalPosts: f.portalPosts === false ? false : DB_CONFIG_DEFAULTS.portalPosts,
  };
}

/** The per-job screening threshold, which also colours the score bar. */
export function scoreThresholdOf(job: { screeningThreshold: number | null }): number {
  return job.screeningThreshold ?? DEFAULT_SCREENING_THRESHOLD;
}
