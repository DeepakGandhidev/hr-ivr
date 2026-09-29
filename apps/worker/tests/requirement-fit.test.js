import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/db/index.js', () => ({
  createAssessmentReport: vi.fn(async () => ({})),
}));

const { PostCallAnalyst, requirementFit } = await import('../src/lib/analysis.js');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const config = { anthropic: { apiKey: 'test', analysisModel: 'claude-sonnet-5' } };

const criteria = [
  { id: 1, criterion: '5+ years selling IT services', weight: 5 },
  { id: 2, criterion: 'Wins clients on Upwork', weight: 5 },
  { id: 3, criterion: 'AI Automation knowledge', weight: 3 },
];

// J62 — fit is reported per requirement, checked against the job's own list.
describe('requirement-by-requirement fit', () => {
  it('keeps one row per known requirement, in the job order, with the job wording', () => {
    const rows = requirementFit(
      [
        { criterion_id: 2, status: 'partly', evidence: 'Mentioned Upwork once.' },
        { criterion_id: 1, status: 'met', evidence: '  Ten years   selling services. ' },
        { criterion_id: 3, status: 'not_met', evidence: 'Did not come up.' },
      ],
      criteria
    );

    expect(rows.map((r) => r.criterionId)).toEqual([1, 2, 3]);
    expect(rows[0]).toEqual({
      criterionId: 1,
      requirement: '5+ years selling IT services',
      kind: 'must',
      status: 'met',
      evidence: 'Ten years selling services.',
    });
    expect(rows[2].kind).toBe('good');
  });

  it('drops invented requirements, unknown statuses, empty evidence and duplicates', () => {
    const rows = requirementFit(
      [
        { criterion_id: 99, status: 'met', evidence: 'A requirement the job does not have.' },
        { criterion_id: 1, status: 'excellent', evidence: 'Not a status we show.' },
        { criterion_id: 2, status: 'met', evidence: '   ' },
        { criterion_id: 3, status: 'met', evidence: 'First.' },
        { criterion_id: 3, status: 'not_met', evidence: 'Second answer for the same one.' },
      ],
      criteria
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ criterionId: 3, status: 'met', evidence: 'First.' });
  });

  it('returns nothing when the model did not produce it, as older runs did not', () => {
    expect(requirementFit(undefined, criteria)).toEqual([]);
    expect(requirementFit('not a list', criteria)).toEqual([]);
  });

  it('stores the rows on the report and keeps the paragraph for older readers', async () => {
    const saveReport = vi.fn(async () => ({}));
    const analyst = new PostCallAnalyst(config, logger, { getTemplate: vi.fn(async () => null), saveReport });
    analyst.anthropic = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'tool_use',
              name: 'submit_assessment',
              input: {
                scores: [],
                strengths: [],
                gaps: [],
                recommendation: 'hold',
                recommendation_reasoning: 'Mixed.',
                interview_score: 7,
                interview_score_reasoning: 'Good answers.',
                jd_fit_summary: 'Meets most requirements.',
                recommendation_score: 5,
                recommendation_verdict: 'Maybe.',
                requirement_fit: [{ criterion_id: 1, status: 'met', evidence: 'Ten years in IT services sales.' }],
              },
            },
          ],
          usage: {},
        }),
      },
    };

    const result = await analyst.analyse({
      id: 'call-1',
      interviewCallId: 'ic-1',
      tenant: { name: 'ProMonkey Technologies' },
      job: { title: 'Senior Sales Expert' },
      latestApprovedJd: { bodyMd: 'Sales' },
      candidate: { name: 'Gaurav', cvParsed: {} },
      criteria,
      transcript: { entries: [{ kind: 'pratibha', text: 'Hello.' }, { kind: 'caller', text: 'Hi there.' }] },
    });

    expect(result.requirement_fit).toHaveLength(1);
    const saved = saveReport.mock.calls[0][0];
    expect(saved.dimensions.requirementFit).toEqual([
      {
        criterionId: 1,
        requirement: '5+ years selling IT services',
        kind: 'must',
        status: 'met',
        evidence: 'Ten years in IT services sales.',
      },
    ]);
    expect(saved.jdFitSummary).toBe('Meets most requirements.');
  });
});
