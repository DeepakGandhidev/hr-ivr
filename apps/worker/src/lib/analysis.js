import { Anthropic } from '@anthropic-ai/sdk';
import { prisma } from '@pratibha/prisma';
import { samplingFor, thinkingFor } from './sampling.js';
import { createAssessmentReport } from '../db/index.js';
import { cvList } from './cv.js';

const INTERNAL_RECOMMENDATIONS = ['pursue', 'hold', 'do_not_pursue'];

const DEFAULT_SYSTEM = `You are assessing a completed first-round screening call for {{tenantName}}.
You are given the job, its must-haves and good-to-haves, the candidate's CV summary, and the full transcript.

Score each criterion from 1 to 5 on the evidence in the transcript.

RULES
- Every score must quote the candidate verbatim from the transcript as its evidence. Copy the words exactly as they appear - do not paraphrase, tidy, or join separate remarks together.
- If a criterion was never reached, or the candidate said nothing that bears on it, do not score it. Report it under not_assessed instead. A guessed score is worse than an absent one.
- Judge only skills, experience and demonstrated work. Never take account of the candidate's name, gender, age, marital status, religion, caste, region of origin, or which institution they attended. Institutional prestige is not evidence of anything.
- Note where demonstrated depth does not match what the CV claims, in either direction.
- You are making a recommendation for a human to act on. You are not deciding anything, and you cannot reject anyone.`;

const SCHEMA = {
  name: 'submit_assessment',
  description: 'File the assessment of this screening call.',
  input_schema: {
    type: 'object',
    properties: {
      scores: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            criterion_id: { type: 'integer' },
            score: { type: 'integer', minimum: 1, maximum: 5 },
            evidence_quote: { type: 'string', description: 'Verbatim from the candidate in the transcript' },
            reasoning: { type: 'string' }
          },
          required: ['criterion_id', 'score', 'evidence_quote', 'reasoning']
        }
      },
      not_assessed: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            criterion_id: { type: 'integer' },
            reason: { type: 'string' }
          },
          required: ['criterion_id', 'reason']
        }
      },
      strengths: { type: 'array', items: { type: 'string' } },
      gaps: { type: 'array', items: { type: 'string' } },
      credibility_notes: { type: 'string', description: 'Does demonstrated depth match the CV claims' },
      flags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['cv_inconsistency', 'notice_period', 'compensation', 'communication', 'other'] },
            detail: { type: 'string' }
          },
          required: ['type', 'detail']
        }
      },
      recommendation: { type: 'string', enum: INTERNAL_RECOMMENDATIONS },
      recommendation_reasoning: { type: 'string' },

      // The two scores are separate and may disagree: the first judges the
      // conversation, the second the whole picture. Asked for explicitly rather
      // than derived, because "interviewed well but does not fit the role" is
      // precisely the case a single averaged number destroys.
      interview_score: {
        type: 'number', minimum: 0, maximum: 10,
        description: 'How the interview itself went, 0-10. Judges the answers given, not CV fit.'
      },
      interview_score_reasoning: {
        type: 'string',
        description: 'Why that interview score, referring to what the candidate actually said.'
      },
      jd_fit_summary: {
        type: 'string',
        description: "How this candidate meets THIS role's stated requirements, one by one, on evidence."
      },
      recommendation_score: {
        type: 'number', minimum: 0, maximum: 10,
        description: 'Overall verdict across JD requirements, CV screening and interview, 0-10.'
      },
      recommendation_verdict: {
        type: 'string',
        description: 'A short, direct verdict consistent with recommendation_score.'
      }
    },
    required: [
      'scores', 'recommendation', 'recommendation_reasoning', 'strengths', 'gaps',
      'interview_score', 'interview_score_reasoning', 'jd_fit_summary',
      'recommendation_score', 'recommendation_verdict'
    ]
  }
};

const normalise = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** A score the model may have omitted, fumbled or put out of range. */
function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(Math.min(10, Math.max(0, n)).toFixed(1));
}

/**
 * Question-and-answer pairs, read off the transcript.
 *
 * Derived rather than generated. The conversation is already recorded, so
 * asking the model to reproduce it would risk questions she never asked
 * appearing in the report as though she had - in the one section a hiring
 * manager reads precisely to check what was really said.
 *
 * A "question" is a Pratibha turn; the answer is the candidate turn that
 * followed it. Turns she takes without a reply (the greeting, the closing) have
 * no answer and are dropped: they are in the transcript, and section 2 is for
 * the questions.
 */
export function pairQuestionsAndAnswers(turns) {
  const pairs = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.speaker !== 'pratibha') continue;

    const answer = turns[i + 1];
    if (!answer || answer.speaker !== 'candidate') continue;

    pairs.push({
      question: turn.text,
      answer: answer.text,
      atMs: turn.atMs ?? 0,
    });
  }

  return pairs;
}

export class PostCallAnalyst {
  constructor(config, logger, deps = {}) {
    this.config = config;
    this.logger = logger;
    this.getTemplate = deps.getTemplate ?? (() => prisma.promptTemplate.findFirst({
      where: { key: 'report_generation', active: true },
      orderBy: { version: 'desc' },
    }));
    this.saveReport = deps.saveReport ?? createAssessmentReport;
    this.anthropic = new Anthropic({
      apiKey: config.anthropic.apiKey,
      ...(config.anthropic.baseUrl ? { baseURL: config.anthropic.baseUrl } : {})
    });
  }

  async analyse(session) {
    const lines = (session.transcript?.entries ?? [])
      .filter(e => e.kind === 'caller' || e.kind === 'pratibha')
      .map(e => `${e.kind === 'caller' ? 'CANDIDATE' : 'PRATIBHA'}: ${e.text}`);

    if (!lines.length) return null;
    const transcript = lines.join('\n');

    const template = await this.getTemplate();

    const system = (template?.body ?? DEFAULT_SYSTEM)
      .replace(/\{\{tenantName\}\}/g, session.tenant?.name ?? 'the hiring team')
      .replace(/\{\{jobTitle\}\}/g, session.job?.title ?? '');

    const response = await this.anthropic.messages.create({
      model: this.config.anthropic.analysisModel,
      max_tokens: 16000,
      ...samplingFor(this.config.anthropic.analysisModel, 0),
      ...thinkingFor(this.config.anthropic.analysisModel),
      system,
      tools: [SCHEMA],
      tool_choice: { type: 'tool', name: 'submit_assessment' },
      messages: [{
        role: 'user',
        content: `ROLE: ${session.job?.title ?? ''}\n` +
          `JOB DESCRIPTION\n${session.latestApprovedJd?.bodyMd ?? session.job?.title ?? ''}\n\n` +
          `SCREENING CRITERIA\n${session.criteria.map(c => `[id ${c.id}] ${c.criterion} (weight ${c.weight}/5). ${c.evaluation_guidance ?? ''}`).join('\n')}\n\n` +
          `CANDIDATE CV SUMMARY\n${this.#cvSummary(session.candidate)}\n\n` +
          `TRANSCRIPT\n${transcript}`
      }]
    });

    const block = response.content.find(c => c.type === 'tool_use');
    if (!block) {
      this.logger.error({ sessionId: session.id }, 'Analysis returned no assessment');
      return null;
    }

    const assessment = this.#validate(block.input, session, transcript);

    if (session.interviewCallId) {
      const overallScore = assessment.scores.length
        ? Number((assessment.scores.reduce((a, s) => a + s.score, 0) / assessment.scores.length).toFixed(2))
        : 0;

      // Question-and-answer pairs come from the transcript that was actually
      // recorded, not from the model. The conversation is already on record, and
      // asking for it back invites questions she never asked.
      const questionAnswers = pairQuestionsAndAnswers(session.transcript?.turns?.() ?? []);

      await this.saveReport({
        interviewCallId: session.interviewCallId,
        overallScore,
        recommendation: mapRecommendation(assessment.recommendation),
        dimensions: {
          scores: assessment.scores,
          notAssessed: assessment.not_assessed,
          recommendationReasoning: assessment.recommendation_reasoning,
          credibilityNotes: assessment.credibility_notes,
          flags: assessment.flags,
        },
        strengths: assessment.strengths,
        concerns: assessment.gaps,
        notableQuotes: {},

        // Falls back to the criterion mean when the model omits the interview
        // score, so section 1 is never blank on a report that has scores.
        interviewScore: clampScore(assessment.interview_score) ?? overallScore,
        interviewScoreReasoning: assessment.interview_score_reasoning ?? null,
        jdFitSummary: assessment.jd_fit_summary ?? null,
        // No fallback: an invented overall verdict is worse than an absent one,
        // and the page says so rather than showing a number nothing produced.
        recommendationScore: clampScore(assessment.recommendation_score),
        recommendationVerdict: assessment.recommendation_verdict ?? null,
        questionAnswers,
      }).catch(err => this.logger.error({ err: err.message }, 'Assessment report save failed'));
    }

    return assessment;
  }

  #cvSummary(candidate) {
    if (!candidate) return '';
    const cv = candidate.cvParsed ?? {};
    const parts = [
      candidate.name ? `Name: ${candidate.name}` : '',
      cv.experience ? `Experience: ${cv.experience}` : '',
      cvList(cv.skills).length ? `Skills: ${cvList(cv.skills).join(', ')}` : '',
      cvList(cv.education).length ? `Education: ${cvList(cv.education).join('; ')}` : '',
      cvList(cv.employers).length ? `Employers: ${cvList(cv.employers).join(', ')}` : '',
      cv.rawPreview ? `Preview: ${cv.rawPreview.slice(0, 500)}` : '',
    ];
    return parts.filter(Boolean).join('\n') || JSON.stringify(candidate.cvParsed ?? {});
  }

  #validate(input, session, transcript) {
    const validIds = new Set(session.criteria.map(c => c.id));
    const haystack = normalise(transcript);

    const scores = [];
    const rejected = [];

    for (const score of input.scores ?? []) {
      const quote = normalise(score.evidence_quote);

      if (!validIds.has(score.criterion_id)) {
        rejected.push({ ...score, dropped_because: 'criterion is not on this job' });
      } else if (!quote || quote.length < 8) {
        rejected.push({ ...score, dropped_because: 'evidence quote missing or too short to verify' });
      } else if (!haystack.includes(quote)) {
        rejected.push({ ...score, dropped_because: 'evidence quote does not appear in the transcript' });
      } else if (!Number.isInteger(score.score) || score.score < 1 || score.score > 5) {
        rejected.push({ ...score, dropped_because: 'score outside 1-5' });
      } else {
        scores.push(score);
      }
    }

    if (rejected.length) {
      this.logger.warn({ sessionId: session.id, rejected }, 'Dropped scores that failed evidence checks');
    }

    const notAssessed = [
      ...(input.not_assessed ?? []).filter(n => validIds.has(n.criterion_id)),
      ...rejected.map(r => ({
        criterion_id: r.criterion_id,
        reason: `Not scored: ${r.dropped_because}.`
      })).filter(n => validIds.has(n.criterion_id))
    ];

    const recommendation = INTERNAL_RECOMMENDATIONS.includes(input.recommendation) ? input.recommendation : 'hold';

    return {
      scores,
      not_assessed: notAssessed,
      strengths: input.strengths ?? [],
      gaps: input.gaps ?? [],
      credibility_notes: input.credibility_notes ?? '',
      flags: input.flags ?? [],
      recommendation,
      recommendation_reasoning: input.recommendation_reasoning ?? '',
      dropped_scores: rejected.length
    };
  }
}

function mapRecommendation(internal) {
  switch (internal) {
    case 'pursue': return 'yes';
    case 'do_not_pursue': return 'no';
    case 'hold':
    default: return 'maybe';
  }
}
