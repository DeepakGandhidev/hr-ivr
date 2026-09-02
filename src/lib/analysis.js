import { Anthropic } from '@anthropic-ai/sdk';
import { samplingFor } from './sampling.js';

const RECOMMENDATIONS = ['pursue', 'hold', 'do_not_pursue'];

const SYSTEM = `You are assessing a completed first-round screening call for ProMonkey Technologies.
You are given the job, its rubric criteria, the candidate's CV summary, and the full transcript.

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
      recommendation: { type: 'string', enum: RECOMMENDATIONS },
      recommendation_reasoning: { type: 'string' }
    },
    required: ['scores', 'recommendation', 'recommendation_reasoning', 'strengths', 'gaps']
  }
};

const normalise = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export class PostCallAnalyst {
  constructor(config, logger, api) {
    this.config = config;
    this.logger = logger;
    this.api = api;
    this.anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  async analyse(session) {
    const lines = (session.transcript?.entries ?? [])
      .filter(e => e.kind === 'caller' || e.kind === 'pratibha')
      .map(e => `${e.kind === 'caller' ? 'CANDIDATE' : 'PRATIBHA'}: ${e.text}`);

    if (!lines.length) return null;
    const transcript = lines.join('\n');

    const response = await this.anthropic.messages.create({
      model: this.config.anthropic.analysisModel,
      // A full rubric assessment with a quote and reasoning per criterion is
      // long, and a truncated one loses scores silently.
      max_tokens: 16000,
      ...samplingFor(this.config.anthropic.analysisModel, 0),
      system: SYSTEM,
      tools: [SCHEMA],
      tool_choice: { type: 'tool', name: 'submit_assessment' },
      messages: [{
        role: 'user',
        content: `ROLE: ${session.job?.title}\n${session.job?.jd_summary}\n\n` +
          `RUBRIC CRITERIA\n${session.criteria.map(c => `[id ${c.id}] ${c.criterion} (weight ${c.weight}/5). ${c.evaluation_guidance ?? ''}`).join('\n')}\n\n` +
          `CANDIDATE CV SUMMARY\n${session.candidate?.cv_summary}\n\n` +
          `TRANSCRIPT\n${transcript}`
      }]
    });

    const block = response.content.find(c => c.type === 'tool_use');
    if (!block) {
      this.logger.error({ sessionId: session.id }, 'Analysis returned no assessment');
      return null;
    }

    const assessment = this.#validate(block.input, session, transcript);

    if (session.osCallId) {
      await this.api.saveAnalysis(session.osCallId, {
        ...assessment,
        // 3.4 - a recommendation, never a decision. The status the API is asked
        // to set is `recommended`; nothing here can reject an application.
        sets_status: 'recommended'
      });
    }
    return assessment;
  }

  /**
   * 3.5 and 10 - no unsupported score reaches the database.
   *
   * A model asked for a verbatim quote will occasionally produce a fluent
   * paraphrase instead, which reads as evidence while being something the
   * candidate never said. Anyone reviewing the shortlist would take it at face
   * value, so a score whose quote is not in the transcript is discarded rather
   * than filed with a caveat.
   */
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

    const recommendation = RECOMMENDATIONS.includes(input.recommendation) ? input.recommendation : 'hold';

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
