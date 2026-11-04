import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/index.js', () => ({
  lookupCandidateByEmail: vi.fn(async () => null),
  recordInterviewCall: vi.fn(async () => ({ id: 'call-1' })),
  updateInterviewCall: vi.fn(async () => ({})),
  createAssessmentReport: vi.fn(async () => ({})),
}));

const { startSettings, __resetSettingsRuntime } = await import('@pratibha/shared/settings-runtime');
const { STATES, TERMINAL } = await import('../src/lib/states.js');
const { SessionManager } = await import('../src/lib/sessionManager.js');
const { ToolExecutor } = await import('../src/lib/toolExecutor.js');
const { ScreeningAgent } = await import('../src/lib/screening.js');
const { PostCallAnalyst, requirementFit } = await import('../src/lib/analysis.js');
const { CallSession, callTiming, deriveCriteria } = await import('../src/lib/callSession.js');

const quiet = { warn: () => {}, info: () => {} };
const withSettings = (rows) => startSettings({ app: 'worker', load: async () => rows, logger: quiet, intervalMs: 1e9 });
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

afterEach(() => __resetSettingsRuntime());

describe('call timing', () => {
  const makeCall = () =>
    new CallSession({ plivo: {}, session: {}, agent: {}, config: { vad: {} }, logger, analyst: {}, stt: {}, tts: {} });

  it('keeps the old limits when nothing is saved', () => {
    expect(callTiming()).toEqual({ idleHangupMs: 45_000, overrunGraceMs: 120_000, drainMs: 20_000 });
  });

  it('reads saved limits when a call starts, and keeps them for that call', async () => {
    await withSettings([
      { key: 'calls.idle_hangup_seconds', value: 90 },
      { key: 'calls.overrun_grace_seconds', value: 30 },
      { key: 'calls.drain_seconds', value: 5 },
    ]);
    const call = makeCall();
    expect(call.timing).toEqual({ idleHangupMs: 90_000, overrunGraceMs: 30_000, drainMs: 5_000 });

    // A change mid-call applies from the next call, as the panel promises.
    __resetSettingsRuntime();
    await withSettings([{ key: 'calls.idle_hangup_seconds', value: 20 }]);
    expect(call.timing.idleHangupMs).toBe(90_000);
    expect(makeCall().timing.idleHangupMs).toBe(20_000);
  });
});

describe('identity and interview length', () => {
  const verifying = () => {
    const session = new SessionManager().create('call-1', { callerNumber: '+919000000000' });
    session.candidate = { id: 'c1', email: 'ananya@example.com' };
    session.state = STATES.VERIFY_EMAIL;
    return session;
  };

  it('ends after two wrong emails by default', async () => {
    const tools = new ToolExecutor({}, logger);
    const session = verifying();
    expect(await tools.execute('confirm_email', { email: 'x@example.com' }, session)).toMatchObject({ attempts_remaining: 1 });
    const second = await tools.execute('confirm_email', { email: 'y@example.com' }, session);
    expect(second.attempts_exhausted).toBe(true);
    expect(session.outcome).toBe(TERMINAL.UNKNOWN_CALLER);
    expect(session.unknownReason.reason).toMatch(/failed twice$/);
  });

  it('allows as many attempts as the panel says', async () => {
    await withSettings([{ key: 'calls.email_verify_attempts', value: 3 }]);
    const tools = new ToolExecutor({}, logger);
    const session = verifying();
    expect(await tools.execute('confirm_email', { email: 'x@example.com' }, session)).toMatchObject({ attempts_remaining: 2 });
    expect(await tools.execute('confirm_email', { email: 'y@example.com' }, session)).toMatchObject({ attempts_remaining: 1 });
    expect(session.ended).toBeFalsy();
    const third = await tools.execute('confirm_email', { email: 'z@example.com' }, session);
    expect(third.attempts_exhausted).toBe(true);
    expect(session.unknownReason.reason).toMatch(/failed 3 times$/);
  });

  it('times an interview with no length of its own by the platform default', async () => {
    const start = async () => {
      const session = new SessionManager().create('call-2', {});
      session.state = STATES.CONSENT_RECORDING;
      await new ToolExecutor({}, logger).execute('record_recording_consent', { granted: true }, session);
      return Math.round((session.deadlineAt - Date.now()) / 60_000);
    };
    expect(await start()).toBe(10);
    await withSettings([{ key: 'calls.default_duration_minutes', value: 25 }]);
    expect(await start()).toBe(25);
  });
});

describe('criteria weights', () => {
  const job = { mustHaves: ['Node.js'], goodToHaves: ['AWS'] };

  it('weights must-haves and nice-to-haves as saved, and the report still tells them apart', async () => {
    expect(deriveCriteria(job).map(c => c.weight)).toEqual([5, 3]);

    await withSettings([
      { key: 'screening.must_have_weight', value: 8 },
      { key: 'screening.nice_to_have_weight', value: 6 },
      { key: 'report.evidence_chars', value: 50 },
    ]);
    const criteria = deriveCriteria(job);
    expect(criteria.map(c => c.weight)).toEqual([8, 6]);

    const rows = requirementFit([
      { criterion_id: 1, status: 'met', evidence: 'x'.repeat(80) },
      { criterion_id: 2, status: 'partly', evidence: 'Used S3 once.' },
    ], criteria);
    expect(rows.map(r => r.kind)).toEqual(['must', 'good']);
    expect(rows[0].evidence).toBe(`${'x'.repeat(47)}…`);
  });
});

describe('model requests', () => {
  const config = { anthropic: { apiKey: 'k1', model: 'claude-haiku-4-5', analysisModel: 'claude-haiku-4-5' } };

  function agentCapturing(response = { content: [], stop_reason: 'end_turn' }) {
    const tools = { definitionsFor: () => [], execute: vi.fn(async () => ({})) };
    const agent = new ScreeningAgent(config, logger, tools);
    agent.buildSystemPrompt = () => 'system';
    const requests = [];
    agent.anthropic = {
      messages: {
        stream: (params) => {
          requests.push(params);
          return {
            async *[Symbol.asyncIterator]() {},
            finalMessage: async () => (typeof response === 'function' ? response() : response),
          };
        },
      },
    };
    return { agent, requests, tools };
  }

  const callSession = (turns = 0) => {
    const session = new SessionManager().create('call-3', {});
    session.state = STATES.SCREEN;
    for (let i = 0; i < turns; i++) {
      session.history.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` });
    }
    return session;
  };

  it('sends the saved token limit, temperature and history window on a call', async () => {
    const before = agentCapturing();
    await before.agent.runTurn(callSession(60), async (t) => t);
    expect(before.requests[0]).toMatchObject({ max_tokens: 600, temperature: 0.3 });
    expect(before.requests[0].messages).toHaveLength(40);

    await withSettings([
      { key: 'ai.call_max_tokens', value: 900 },
      { key: 'ai.call_temperature', value: 0.6 },
      { key: 'calls.max_history_turns', value: 10 },
    ]);
    const after = agentCapturing();
    await after.agent.runTurn(callSession(60), async (t) => t);
    expect(after.requests[0]).toMatchObject({ max_tokens: 900, temperature: 0.6 });
    expect(after.requests[0].messages).toHaveLength(10);
  });

  it('escalates once the saved tool chain limit is reached', async () => {
    await withSettings([{ key: 'calls.max_tool_chain', value: 2 }]);
    const toolTurn = () => ({ content: [{ type: 'tool_use', id: `t${Math.random()}`, name: 'record_detail', input: {} }], stop_reason: 'tool_use' });
    const { agent, requests, tools } = agentCapturing(toolTurn);
    const session = callSession(1);
    await agent.runTurn(session, async (t) => t);
    expect(requests).toHaveLength(2);
    expect(tools.execute).toHaveBeenLastCalledWith('escalate', expect.objectContaining({ category: 'other' }), session);
  });

  it('sends the saved token limit and temperature for the report', async () => {
    await withSettings([
      { key: 'ai.analysis_max_tokens', value: 8000 },
      { key: 'ai.analysis_temperature', value: 0.1 },
    ]);
    const analyst = new PostCallAnalyst(config, logger, { getTemplate: async () => null, saveReport: vi.fn() });
    const create = vi.fn(async () => ({ content: [] }));
    analyst.anthropic = { messages: { create } };
    await analyst.analyse({
      id: 'call-4',
      criteria: [],
      transcript: { entries: [{ kind: 'pratibha', text: 'Hello.' }, { kind: 'caller', text: 'Hi.' }] },
    });
    expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 8000, temperature: 0.1 });
  });
});

describe('the AI client follows the configured key', () => {
  it('is reused while nothing changes and rebuilt when the key, endpoint or timeout does', () => {
    const config = { anthropic: { apiKey: 'key-one', timeoutMs: 12_000, maxRetries: 1 } };
    const agent = new ScreeningAgent(config, logger, { definitionsFor: () => [] });
    const first = agent.anthropic;
    expect(agent.anthropic).toBe(first);
    expect(first.apiKey).toBe('key-one');
    expect(first.timeout).toBe(12_000);

    // What config/live.js does when the panel changes a value.
    config.anthropic.apiKey = 'key-two';
    config.anthropic.baseUrl = 'https://llm.example.test';
    const second = agent.anthropic;
    expect(second).not.toBe(first);
    expect(second.apiKey).toBe('key-two');
    expect(second.baseURL).toBe('https://llm.example.test');

    config.anthropic.timeoutMs = 5_000;
    expect(agent.anthropic.timeout).toBe(5_000);

    const analyst = new PostCallAnalyst(config, logger, { getTemplate: async () => null });
    const report = analyst.anthropic;
    config.anthropic.apiKey = 'key-three';
    expect(analyst.anthropic).not.toBe(report);
    expect(analyst.anthropic.apiKey).toBe('key-three');
  });
});
