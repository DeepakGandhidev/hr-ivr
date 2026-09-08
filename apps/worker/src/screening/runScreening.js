import { prisma, withTenant } from '@pratibha/prisma';
import { TRIAL_LIMITS } from '@pratibha/shared';
import { LlmProvider } from './provider.js';
import { getOrCreateUsageMeter, incrementScreeningUsage } from '../db/index.js';

const DEFAULT_PROMPT = `You are a CV screening assistant for an inbound hiring pipeline.

JOB DESCRIPTION
{{jd}}

MUST-HAVES
{{mustHaves}}

GOOD-TO-HAVES
{{goodToHaves}}

CANDIDATE CV
{{cv}}

Screen the candidate. Return strict JSON with:
- score: integer 0-100
- verdict: either "shortlist" or "archive"
- matchedMustHaves: array of strings
- gaps: array of strings
- reasonSummary: one-line reasoning

Be concise. Do not explain outside JSON.`;

function renderTemplate(template, vars) {
  if (!template) return null;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

function safeJsonParse(text) {
  try {
    const cleaned = text.replace(/^```json\s*|\s*```$/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function estimateCostUsd(inputTokens, outputTokens) {
  // Approximate Anthropic Haiku-like blended rate for P0 cost tracking.
  return Number((inputTokens * 0.00000025 + outputTokens * 0.00000125).toFixed(6));
}

async function withinQuota(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { plan: true },
  });
  if (!tenant) return { ok: false, reason: 'tenant_not_found' };

  const isTrial = tenant.status === 'trial';
  const planLimits = isTrial ? TRIAL_LIMITS : (tenant.plan?.limits ?? {});
  const meter = await getOrCreateUsageMeter(tenantId);

  const limit = Number(planLimits.screenings ?? Infinity);
  if (meter.screeningsUsed >= limit) {
    return { ok: false, reason: 'screening_quota_exceeded', limit, used: meter.screeningsUsed };
  }
  return { ok: true, limit, used: meter.screeningsUsed };
}

/**
 * Run an asynchronous CV screening for a candidate.
 *
 * Enforces the tenant's screening quota before calling the model, persists a
 * Screening row with token/cost metadata, and creates a ShortlistItem when the
 * verdict is "shortlist".
 */
export async function runScreening(candidateId, config, logger = console) {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    include: { job: { include: { descriptions: { where: { approvedAt: { not: null } }, orderBy: { approvedAt: 'desc' }, take: 1 } } }, tenant: { include: { plan: true } } },
  });

  if (!candidate) throw new Error(`Candidate ${candidateId} not found`);
  if (!candidate.cvParsed) throw new Error(`Candidate ${candidateId} has no parsed CV`);

  const tenantId = candidate.tenantId;
  const quota = await withinQuota(tenantId);
  if (!quota.ok) {
    logger.warn({ candidateId, tenantId, reason: quota.reason }, 'Screening blocked by quota');
    return { ran: false, reason: quota.reason };
  }

  const jd = candidate.job.descriptions[0]?.bodyMd ?? candidate.job.title ?? '';
  const mustHaves = Array.isArray(candidate.job.mustHaves)
    ? candidate.job.mustHaves.join('\n')
    : String(candidate.job.mustHaves ?? '');
  const goodToHaves = Array.isArray(candidate.job.goodToHaves)
    ? candidate.job.goodToHaves.join('\n')
    : String(candidate.job.goodToHaves ?? '');
  const cv = typeof candidate.cvParsed === 'string'
    ? candidate.cvParsed
    : JSON.stringify(candidate.cvParsed, null, 2);

  const template = await prisma.promptTemplate.findFirst({
    where: { key: 'cv_screening', active: true },
    orderBy: { version: 'desc' },
  });

  const system = renderTemplate(template?.body ?? DEFAULT_PROMPT, {
    jd,
    mustHaves,
    goodToHaves,
    cv,
    candidateName: candidate.name ?? '',
    jobTitle: candidate.job.title ?? '',
  });

  const provider = new LlmProvider(config, logger);
  const result = await provider.complete({
    system,
    messages: [{ role: 'user', content: 'Screen this candidate and return JSON only.' }],
    maxTokens: 1024,
    temperature: 0.2,
  });

  const parsed = result.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n');

  const assessment = safeJsonParse(parsed);
  if (!assessment) {
    logger.error({ candidateId, raw: parsed }, 'Could not parse screening JSON');
    throw new Error('screening response was not valid JSON');
  }

  const inputTokens = result.usage.inputTokens;
  const outputTokens = result.usage.outputTokens;
  const costUsd = estimateCostUsd(inputTokens, outputTokens);

  const screening = await withTenant(tenantId, async (tx) => {
    const created = await tx.screening.create({
      data: {
        candidateId,
        score: Number(assessment.score ?? 0),
        matchedMustHaves: assessment.matchedMustHaves ?? [],
        gaps: assessment.gaps ?? [],
        model: result.model,
        tokensIn: inputTokens,
        tokensOut: outputTokens,
        costUsd,
        verdict: assessment.verdict === 'shortlist' ? 'shortlist' : 'archive',
        reasonSummary: assessment.reasonSummary ?? '',
        failed: false,
      },
    });

    if (created.verdict === 'shortlist') {
      let shortlist = await tx.shortlist.findFirst({ where: { jobId: candidate.jobId } });
      if (!shortlist) {
        shortlist = await tx.shortlist.create({ data: { jobId: candidate.jobId, status: 'draft' } });
      }
      await tx.shortlistItem.upsert({
        where: { shortlistId_candidateId: { shortlistId: shortlist.id, candidateId } },
        update: {},
        create: { shortlistId: shortlist.id, candidateId, addedBy: 'ai' },
      });
    }

    return created;
  });

  await incrementScreeningUsage(tenantId);

  return {
    ran: true,
    screening,
    verdict: assessment.verdict,
    score: assessment.score,
    costUsd,
  };
}
