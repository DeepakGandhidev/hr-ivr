import { describe, it, expect, vi } from 'vitest';
import { STATES } from '../src/lib/states.js';

vi.mock('@pratibha/prisma', () => ({ prisma: {} }));

const { ScreeningAgent } = await import('../src/lib/screening.js');

const config = {
  anthropic: { apiKey: 'k', model: 'claude-sonnet-5' },
  pratibhaNumber: '+911234567890',
};

const tools = { definitionsFor: () => [] };
const agent = new ScreeningAgent(config, { info() {}, warn() {}, error() {} }, tools);

const session = (protocol = {}, over = {}) => ({
  state: STATES.SCREEN,
  tenant: { name: 'Acme Corp' },
  job: { title: 'MERN Stack Developer' },
  candidate: { name: 'Priya' },
  criteria: [{ id: 1, criterion: 'React', weight: 5 }],
  history: [],
  questionsAsked: 2,
  interviewProtocol: protocol,
  ...over,
});

describe('interview length and depth come from the job settings', () => {
  it('uses the configured question range instead of a fixed one', () => {
    const prompt = agent.buildSystemPrompt(session({ minQuestions: 3, maxQuestions: 5 }));
    expect(prompt).toContain('3 to 5 questions');
    // The old prompt hard-coded this for every role, fresher or staff engineer.
    expect(prompt).not.toContain('Six to ten questions is normal');
  });

  it('states the time budget', () => {
    const prompt = agent.buildSystemPrompt(session({ durationMinutes: 25 }));
    expect(prompt).toContain('25 minutes');
  });

  it.each([
    ['easy', 'Accept a good-enough answer'],
    ['moderate', 'Push back gently'],
    ['hard', 'Probe for depth'],
    ['expert', 'senior-hire depth'],
  ])('changes how it questions at %s difficulty', (difficulty, marker) => {
    const prompt = agent.buildSystemPrompt(session({ difficulty }));
    expect(prompt).toContain(marker);
  });

  it('mentions focus areas when they are set', () => {
    const prompt = agent.buildSystemPrompt(session({ focusAreas: ['system design', 'caching'] }));
    expect(prompt).toContain('system design, caching');
  });

  it('omits the focus line entirely when none are set', () => {
    const prompt = agent.buildSystemPrompt(session({ focusAreas: [] }));
    expect(prompt).not.toContain('extra weight to these areas');
  });
});

describe('falling back safely', () => {
  it('uses sane defaults when a job has no protocol at all', () => {
    const prompt = agent.buildSystemPrompt(session(undefined, { interviewProtocol: null }));
    expect(prompt).toContain('6 to 10 questions');
    expect(prompt).toContain('10 minutes');
  });

  it('ignores an unknown difficulty rather than dropping the guidance', () => {
    const prompt = agent.buildSystemPrompt(session({ difficulty: 'brutal' }));
    expect(prompt).toContain('Push back gently'); // moderate
  });

  // A max below the min would make the wrap-up instruction contradict itself.
  it('never states a maximum below the minimum', () => {
    const prompt = agent.buildSystemPrompt(session({ minQuestions: 8, maxQuestions: 3 }));
    expect(prompt).toContain('8 to 8 questions');
  });
});

describe('who the agent says it is', () => {
  it('uses the tenant name by default', () => {
    expect(agent.buildSystemPrompt(session({}))).toContain('Acme Corp');
  });

  // One workspace can hire under more than one brand.
  it('prefers a per-job company name when set', () => {
    const prompt = agent.buildSystemPrompt(session({ companyName: 'Globex Labs' }));
    expect(prompt).toContain('Globex Labs');
  });
});

describe('progress reporting mid-interview', () => {
  it('tells the model how far through it is', () => {
    const prompt = agent.buildSystemPrompt(session({ minQuestions: 6, maxQuestions: 10 }));
    expect(prompt).toContain('asked 2 questions of a planned 6-10');
  });

  it('tells it to wrap up once the question budget is spent', () => {
    const prompt = agent.buildSystemPrompt(
      session({ minQuestions: 2, maxQuestions: 3 }, { questionsAsked: 3 })
    );
    expect(prompt).toContain('Wrap up now');
  });

  it('tells it to wrap up once the time is gone', () => {
    const prompt = agent.buildSystemPrompt(
      session({ maxQuestions: 30 }, { deadlineAt: Date.now() - 1000 })
    );
    expect(prompt).toContain('Wrap up now');
  });

  it('reports the minutes remaining while there is still time', () => {
    const prompt = agent.buildSystemPrompt(
      session({ maxQuestions: 30 }, { deadlineAt: Date.now() + 5 * 60_000 })
    );
    expect(prompt).toMatch(/About 5 minutes? of the interview remain/);
  });
});
