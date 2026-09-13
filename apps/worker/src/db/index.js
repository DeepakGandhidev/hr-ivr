import { prisma } from '@pratibha/prisma';
import { advanceCandidateStatus } from '@pratibha/shared';
import { emailsMatch, normaliseSpokenEmail } from '../lib/emailMatch.js';

// Worker queries cross tenant boundaries for caller recognition, so this process
// must connect with a Postgres role that bypasses RLS (e.g. Supabase service_role
// or a local superuser). The web app uses withTenant() to enforce RLS per request.

function normalizePhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // E.164: optional leading + then digits. Reject anything with letters.
  if (/[a-zA-Z]/.test(s)) return null;
  const digits = s.replace(/[^0-9+]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(digits)) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function currentPeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function snapshotContains(snapshot, candidateId) {
  if (!snapshot) return false;
  if (Array.isArray(snapshot)) {
    return snapshot.some((entry) => {
      if (entry === null || entry === undefined) return false;
      if (typeof entry === 'string') return entry === candidateId;
      return (entry.id ?? entry.candidateId) === candidateId;
    });
  }
  if (typeof snapshot === 'object') {
    if (snapshot.candidateIds?.includes(candidateId)) return true;
    if (snapshot[candidateId] === true) return true;
    return false;
  }
  return false;
}

/**
 * Exported so the approval contract can be tested directly: both halves — the
 * item's finalState and the approval snapshot — must agree before a caller is
 * allowed into an interview.
 */
export function isApprovedFromRecord(candidate) {
  return candidate.shortlistItems?.some((item) =>
    item.finalState === 'approved' &&
    item.shortlist?.approvals?.some((approval) =>
      snapshotContains(approval.snapshot, candidate.id)
    )
  );
}

/**
 * Find a candidate by E.164 phone number across tenants.
 * Prefers an approved-shortlist candidate; falls back to the most recent row if
 * no approved match exists (so the caller can still be told why they are not
 * shortlisted).
 */
export async function lookupCandidateByPhone(phoneE164) {
  const normalized = normalizePhone(phoneE164);
  if (!normalized) return null;

  const candidates = await prisma.candidate.findMany({
    where: { phoneE164: normalized },
    include: {
      tenant: true,
      job: { include: { callWindows: true } },
      shortlistItems: {
        include: {
          shortlist: {
            include: { approvals: true },
          },
        },
      },
      interviewCalls: { select: { id: true, status: true, endedAt: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!candidates.length) return null;

  const approved = candidates.find(isApprovedFromRecord);
  const candidate = approved ?? candidates[0];

  const [latestApprovedJd, jobProtocol, tenantProtocol] = await Promise.all([
    prisma.jobDescription.findFirst({
      where: { jobId: candidate.jobId, approvedAt: { not: null } },
      orderBy: { approvedAt: 'desc' },
    }),
    prisma.interviewProtocol.findUnique({
      where: { tenantId_jobId: { tenantId: candidate.tenantId, jobId: candidate.jobId } },
    }),
    prisma.interviewProtocol.findFirst({
      where: { tenantId: candidate.tenantId, jobId: null },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const interviewProtocol = jobProtocol ?? tenantProtocol ?? null;
  const hasCompleted = candidate.interviewCalls.some((call) => call.status === 'completed');

  return {
    candidate,
    job: candidate.job,
    tenant: candidate.tenant,
    latestApprovedJd,
    callWindows: candidate.job.callWindows ?? [],
    interviewProtocol,
    approved: isApprovedFromRecord(candidate),
    hasCompleted,
  };
}

/**
 * Resolve a spoken email address to a candidate.
 *
 * An exact match is tried first, but it almost never lands: a caller reading
 * their address down an 8 kHz line produces "ananya at the rate example dot
 * com", "Ananya@example.com." or "deepak@promoinky.tech" for addresses that are
 * perfectly correct on file. Requiring an exact string turned identify-by-email
 * — the only route in for anyone calling from a different phone — into a
 * near-guaranteed dead end.
 *
 * The fallback compares against candidates on an approved shortlist only, since
 * nobody else can be interviewed anyway, and it insists on a UNIQUE match. Two
 * plausible candidates means we do not know who is calling, and guessing would
 * hand one person's interview to another.
 */
async function resolveEmailToCandidateIds(emailLike) {
  const said = normaliseSpokenEmail(emailLike);
  if (!said) return [];

  if (said.includes('@')) {
    const exact = await prisma.candidate.findMany({ where: { email: said }, select: { id: true } });
    if (exact.length) return exact.map((c) => c.id);
  }

  // Every applicant with an email is a candidate for the fuzzy match, not just
  // approved ones. Restricting the pool to approved shortlist items meant an
  // ordinary applicant reading out their own address was told it did not exist.
  const pool = await prisma.candidate.findMany({
    where: { email: { not: null } },
    select: { id: true, email: true },
  });

  const matches = pool.filter((c) => emailsMatch(said, c.email));
  // Ambiguity is a refusal, not a coin toss.
  return matches.length === 1 ? [matches[0].id] : [];
}

export async function lookupCandidateByEmail(emailLike) {
  const ids = await resolveEmailToCandidateIds(emailLike);
  if (!ids.length) return null;

  const candidates = await prisma.candidate.findMany({
    where: { id: { in: ids } },
    include: {
      tenant: true,
      job: { include: { callWindows: true } },
      shortlistItems: {
        include: {
          shortlist: {
            include: { approvals: true },
          },
        },
      },
      interviewCalls: { select: { id: true, status: true, endedAt: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!candidates.length) return null;

  const approved = candidates.find(isApprovedFromRecord);
  const candidate = approved ?? candidates[0];

  const [latestApprovedJd, jobProtocol, tenantProtocol] = await Promise.all([
    prisma.jobDescription.findFirst({
      where: { jobId: candidate.jobId, approvedAt: { not: null } },
      orderBy: { approvedAt: 'desc' },
    }),
    prisma.interviewProtocol.findUnique({
      where: { tenantId_jobId: { tenantId: candidate.tenantId, jobId: candidate.jobId } },
    }),
    prisma.interviewProtocol.findFirst({
      where: { tenantId: candidate.tenantId, jobId: null },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const interviewProtocol = jobProtocol ?? tenantProtocol ?? null;
  const hasCompleted = candidate.interviewCalls.some((call) => call.status === 'completed');

  return {
    candidate,
    job: candidate.job,
    tenant: candidate.tenant,
    latestApprovedJd,
    callWindows: candidate.job.callWindows ?? [],
    interviewProtocol,
    approved: isApprovedFromRecord(candidate),
    hasCompleted,
  };
}

export async function isApprovedForInterview(candidateId) {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    include: {
      shortlistItems: {
        include: {
          shortlist: {
            include: { approvals: true },
          },
        },
      },
    },
  });
  if (!candidate) return false;
  return isApprovedFromRecord(candidate);
}

export async function hasCompletedInterview(candidateId) {
  const call = await prisma.interviewCall.findFirst({
    where: { candidateId, status: 'completed' },
    select: { id: true },
  });
  return Boolean(call);
}

export async function recordInterviewCall(payload) {
  return prisma.interviewCall.create({
    data: {
      candidateId: payload.candidateId,
      callerNumber: payload.callerNumber,
      recognised: payload.recognised ?? false,
      language: payload.language ?? null,
      status: payload.status ?? 'unknown_caller',
      telephonyCost: payload.telephonyCost ?? 0,
      llmCostUsd: payload.llmCostUsd ?? 0,
      ttsCostUsd: payload.ttsCostUsd ?? 0,
      sttCostUsd: payload.sttCostUsd ?? 0,
    },
  });
}

export async function updateInterviewCall(id, payload) {
  return prisma.interviewCall.update({
    where: { id },
    data: {
      ...(payload.endedAt !== undefined && { endedAt: payload.endedAt }),
      ...(payload.language !== undefined && { language: payload.language }),
      ...(payload.status !== undefined && { status: payload.status }),
      ...(payload.recordingRef !== undefined && { recordingRef: payload.recordingRef }),
      ...(payload.transcriptRef !== undefined && { transcriptRef: payload.transcriptRef }),
      ...(payload.transcript !== undefined && { transcript: payload.transcript }),
      ...(payload.telephonyCost !== undefined && { telephonyCost: payload.telephonyCost }),
      ...(payload.llmCostUsd !== undefined && { llmCostUsd: payload.llmCostUsd }),
      ...(payload.ttsCostUsd !== undefined && { ttsCostUsd: payload.ttsCostUsd }),
      ...(payload.sttCostUsd !== undefined && { sttCostUsd: payload.sttCostUsd }),
    },
  });
}

export async function createAssessmentReport(payload) {
  const report = await prisma.assessmentReport.create({
    data: {
      interviewCallId: payload.interviewCallId,
      overallScore: payload.overallScore,
      recommendation: payload.recommendation,
      dimensions: payload.dimensions ?? {},
      strengths: payload.strengths ?? [],
      concerns: payload.concerns ?? [],
      notableQuotes: payload.notableQuotes ?? {},
      interviewScore: payload.interviewScore ?? null,
      interviewScoreReasoning: payload.interviewScoreReasoning ?? null,
      jdFitSummary: payload.jdFitSummary ?? null,
      recommendationScore: payload.recommendationScore ?? null,
      recommendationVerdict: payload.recommendationVerdict ?? null,
      questionAnswers: payload.questionAnswers ?? [],
    },
  });

  // "Interviewed" means the call happened AND produced a report, which is the
  // same bar billing uses - so it is set here, where the report lands, rather
  // than when the call ends. A call that never yields a report leaves the
  // candidate where they were.
  //
  // Never allowed to fail the report: the assessment is the artifact worth
  // keeping, and a status label is not worth losing it over.
  try {
    const call = await prisma.interviewCall.findUnique({
      where: { id: payload.interviewCallId },
      select: { candidate: { select: { id: true, tenantId: true } } },
    });

    if (call?.candidate) {
      await advanceCandidateStatus(prisma, {
        tenantId: call.candidate.tenantId,
        candidateId: call.candidate.id,
        to: 'interviewed',
        reason: 'Interview completed and assessment report generated',
      });
    }
  } catch {
    // Left to the next event to correct; the report itself is already saved.
  }

  return report;
}

export async function getOrCreateUsageMeter(tenantId, period = currentPeriod()) {
  return prisma.usageMeter.upsert({
    where: { tenantId_period: { tenantId, period } },
    update: {},
    create: { tenantId, period },
  });
}

export async function incrementScreeningUsage(tenantId, period = currentPeriod()) {
  return prisma.usageMeter.upsert({
    where: { tenantId_period: { tenantId, period } },
    update: { screeningsUsed: { increment: 1 } },
    create: { tenantId, period, screeningsUsed: 1 },
  });
}

export async function incrementInterviewUsage(tenantId, period = currentPeriod()) {
  return prisma.usageMeter.upsert({
    where: { tenantId_period: { tenantId, period } },
    update: { interviewsUsed: { increment: 1 } },
    create: { tenantId, period, interviewsUsed: 1 },
  });
}

export { prisma };
