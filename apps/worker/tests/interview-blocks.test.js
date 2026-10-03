import { describe, it, expect, vi } from 'vitest';
import { STATES, TERMINAL } from '../src/lib/states.js';
import { assembleInterviewPrompt, interviewOptionsFrom, parseCtc } from '@pratibha/shared';
import { shippedPromptBlocks } from './support/prompt-blocks.js';

vi.mock('@pratibha/prisma', () => ({ prisma: {} }));

const { ScreeningAgent } = await import('../src/lib/screening.js');
const { ToolExecutor } = await import('../src/lib/toolExecutor.js');
const { salaryConcern } = await import('../src/lib/analysis.js');

const library = shippedPromptBlocks();
const ctx = {
  agentName: 'Pratibha',
  tenantName: 'Acme',
  languageHint: '- English.',
  jdSummary: 'Sell software to retailers.',
  criteriaList: '- [id 1] React',
  gaps: [],
  jobLocation: 'Gurugram',
  bandMin: 600000,
  bandMax: 800000,
};
const used = (row, over = {}) => assembleInterviewPrompt(library, interviewOptionsFrom(row), { ...ctx, ...over }).used;

describe('I10: one block per enabled option, in a fixed order', () => {
  it('starts with the fixed core and ends with the team\'s own words', () => {
    const blocks = used({ instructionText: 'Be warm.' });
    expect(blocks[0]).toBe('core');
    expect(blocks.at(-1)).toBe('instructions');
  });

  it('follows the order the brief sets', () => {
    const blocks = used({ customQuestions: ['Why sales?'], instructionText: 'x' }, { gaps: ['A gap'] });
    const order = ['core', 'role_intro', 'core_questions', 'custom_questions', 'screeners', 'salary_share_band', 'salary_check', 'candidate_questions', 'hear_back', 'close', 'instructions'];
    expect(blocks.filter((b) => order.includes(b))).toEqual(order);
  });

  it.each([
    ['introduceRole', 'role_intro'],
    ['candidateQuestions', 'candidate_questions'],
    ['screenNotice', 'screener_notice'],
    ['screenSalary', 'screener_salary'],
    ['screenReasonLeaving', 'screener_reason_leaving'],
    ['screenLocation', 'screener_location'],
    ['screenWorkMode', 'screener_work_mode'],
    ['screenTravel', 'screener_travel'],
    ['screenReference', 'screener_reference'],
  ])('toggling %s adds or removes exactly %s', (field, block) => {
    const on = used({ [field]: true });
    const off = used({ [field]: false });
    const added = on.filter((b) => !off.includes(b));
    const removed = off.filter((b) => !on.includes(b));
    // Salary also carries its policy block; every other switch is one block.
    if (field === 'screenSalary') expect(added).toEqual(['screener_salary', 'salary_share_band', 'salary_check']);
    else expect(added).toEqual([block]);
    expect(removed).toEqual([]);
  });

  it('switches the salary policy block with the mismatch action', () => {
    for (const action of ['note', 'check', 'end']) {
      expect(used({ mismatchAction: action })).toContain(`salary_${action}`);
    }
  });

  it('shares the band only when told to and when the role has one', () => {
    expect(used({ shareBand: true })).toContain('salary_share_band');
    expect(used({ shareBand: false })).not.toContain('salary_share_band');
    expect(used({ shareBand: true }, { bandMax: null })).not.toContain('salary_share_band');
  });

  it('drops the hear back line when no days are set', () => {
    expect(used({ hearBackDays: 3 })).toContain('hear_back');
    expect(used({ hearBackDays: null })).not.toContain('hear_back');
  });
});

describe('I11 and I13', () => {
  it('asks about gaps only when screening flagged one, and passes the detail in', () => {
    expect(used({ screenGaps: true })).not.toContain('screener_gaps');
    const { text, used: blocks } = assembleInterviewPrompt(library, interviewOptionsFrom({ screenGaps: true }), { ...ctx, gaps: ['No TypeScript on the CV'] });
    expect(blocks).toContain('screener_gaps');
    expect(text).toContain('No TypeScript on the CV');
  });

  it('puts custom questions in word for word, three at most', () => {
    const qs = ['Why do you want to sell to retailers?', 'Q2?', 'Q3?', 'Q4?'];
    const { text } = assembleInterviewPrompt(library, interviewOptionsFrom({ customQuestions: qs }), ctx);
    expect(text).toContain('1. Why do you want to sell to retailers?');
    expect(text).toContain('one follow up on each');
    expect(text).not.toContain('Q4?');
  });

  it('states the band in rupees people say', () => {
    const { text } = assembleInterviewPrompt(library, interviewOptionsFrom({}), ctx);
    expect(text).toContain('6 to 8 lakh a year');
  });
});

describe('the agent prompt', () => {
  const agent = new ScreeningAgent({ anthropic: { apiKey: 'k', model: 'm' } }, { info() {}, warn() {}, error() {} }, { definitionsFor: () => [] });
  const transcript = { events: [], record(type, data) { this.events.push({ type, data }); } };
  const session = {
    state: STATES.SCREEN, history: [], questionsAsked: 1, transcript, promptBlocks: library,
    tenant: { name: 'Acme' }, job: { title: 'Sales', salaryMin: 600000, salaryMax: 800000 },
    candidate: { name: 'Priya' }, criteria: [{ id: 1, criterion: 'Retail sales', weight: 5 }],
    interviewProtocol: { agentName: 'Asha', screenReference: true },
    latestApprovedJd: { bodyMd: 'Sell to retailers.' },
  };

  it('logs the blocks it used, which is the preview of what a setting did', () => {
    const prompt = agent.buildSystemPrompt(session);
    const event = transcript.events.find((e) => e.type === 'prompt.assembled');
    expect(event.data.blocks.split(',')).toContain('screener_reference');
    expect(prompt).toContain('You are Asha');
    expect(prompt).toContain('Would you like to share a reference from your last job');
  });

  it('keeps interview content out until the caller is verified', () => {
    const prompt = agent.buildSystemPrompt({ ...session, state: STATES.VERIFY_EMAIL, transcript: undefined });
    expect(prompt).not.toContain('PRACTICAL QUESTIONS');
    expect(prompt).toContain('WHAT YOU MUST NEVER DO');
  });
});

describe('I12: salary mismatch', () => {
  const tools = new ToolExecutor({}, { info() {}, warn() {}, error() {} });
  const call = (action, over = {}) => ({
    state: STATES.SCREEN,
    promptBlocks: library,
    job: { title: 'Sales', salaryMin: 600000, salaryMax: 800000 },
    interviewProtocol: { mismatchAction: action },
    transcript: { record() {} },
    finish(outcome) { this.outcome = outcome; this.ended = true; },
    setState(s) { this.state = s; },
    ...over,
  });

  it('parses the forms candidates use', () => {
    expect(parseCtc('50L')).toBe(5_000_000);
    expect(parseCtc('50 lakh')).toBe(5_000_000);
    expect(parseCtc('5000000')).toBe(5_000_000);
    expect(parseCtc('twelve LPA')).toBe(1_200_000);
  });

  it('note: records it silently', async () => {
    const s = call('note');
    const r = await tools.execute('record_detail', { field: 'expected_ctc', value: '12 lakh' }, s);
    expect(r.say_exactly).toBeUndefined();
    expect(s.salaryMismatch).toBe(true);
    expect(s.practicalDetails.expectedCtc.annual).toBe(1_200_000);
  });

  it('check: states the band and asks whether they can work within it', async () => {
    const s = call('check');
    const r = await tools.execute('record_detail', { field: 'expected_ctc', value: '12 lakh' }, s);
    expect(r.say_exactly).toBe('Thanks for sharing that. For this role the band is 6 to 8 lakh a year. Would you be able to work within that?');
    await tools.execute('record_detail', { field: 'band_answer', value: 'Yes, I could manage 8' }, s);
    expect(s.practicalDetails.bandAnswer).toBe('Yes, I could manage 8');
  });

  it('end: wraps up politely and the call still counts as completed', async () => {
    const s = call('end');
    const r = await tools.execute('record_detail', { field: 'expected_ctc', value: '12 lakh' }, s);
    expect(r.say_exactly).toMatch(/^Thank you for being open about that\./);
    expect(r.ended).toBe(true);
    expect(s.outcome).toBe(TERMINAL.COMPLETED);
  });

  it('within the band: nothing happens', async () => {
    const s = call('end');
    const r = await tools.execute('record_detail', { field: 'expected_ctc', value: '7.5 LPA' }, s);
    expect(r.say_exactly).toBeUndefined();
    expect(s.salaryMismatch).toBeUndefined();
  });

  it('I21: a mismatch always lands in the report as a concern', async () => {
    const s = call('note');
    await tools.execute('record_detail', { field: 'expected_ctc', value: '12 lakh' }, s);
    const [concern] = salaryConcern(s);
    expect(concern).toBe("Salary mismatch: expects about 12 lakh a year, above the role's band of 6 to 8 lakh. Noted without raising it on the call.");
  });
});
