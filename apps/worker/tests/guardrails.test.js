import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { STATES, TERMINAL, TOOLS_BY_STATE, canTransition, isVerified } from '../src/lib/states.js';
import { makeDisclosure, identityConfirmed } from '../src/lib/screening.js';
import { ToolExecutor } from '../src/lib/toolExecutor.js';
import { SessionManager } from '../src/lib/sessionManager.js';
import { DISCLOSURE, makeDisclosure } from '../src/lib/screening.js';
import { PostCallAnalyst } from '../src/lib/analysis.js';
import { isWithinOperatingHours, closedXml, streamXml, describeHours } from '../src/lib/plivoXml.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

vi.mock('../src/db/index.js', () => ({
  lookupCandidateByEmail: vi.fn(),
  recordInterviewCall: vi.fn(async () => ({ id: 'call-1' })),
  updateInterviewCall: vi.fn(async () => ({})),
  createAssessmentReport: vi.fn(async () => ({})),
  incrementInterviewUsage: vi.fn(async () => ({})),
}));

import * as db from '../src/db/index.js';

const config = {
  mockMode: true,
  operatingHours: {
    timezone: 'Asia/Kolkata',
    days: [1, 2, 3, 4, 5, 6],
    startHour: 10,
    endHour: 19,
    label: 'Monday to Saturday, 10 a.m. to 7 p.m.'
  },
  publicWsUrl: 'wss://hiring.promonkey.tech/pratibha/stream',
  publicBaseUrl: 'https://hiring.promonkey.tech',
  anthropic: { apiKey: 'test', analysisModel: 'claude-sonnet-5' }
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const approvedLookup = {
  candidate: { id: 'c1', name: 'Ananya', cvParsed: { experience: '6 years', skills: ['Node.js'] } },
  job: { id: 'j1', title: 'Senior Backend Engineer', mustHaves: ['Backend depth in Node.js'], goodToHaves: ['AWS'], callWindows: [] },
  tenant: { id: 't1', name: 'ProMonkey Technologies' },
  latestApprovedJd: { bodyMd: 'Senior backend role.' },
  interviewProtocol: { instructionText: 'Ask about production systems.' },
  approved: true,
  hasCompleted: false,
};

function harness(lookup = approvedLookup) {
  vi.clearAllMocks();
  db.lookupCandidateByEmail.mockResolvedValue(lookup);

  const sessions = new SessionManager();
  const session = sessions.create('call-1', { callerNumber: '+919000000000' });
  session.state = STATES.IDENTIFY;
  return { session, tools: new ToolExecutor(config, logger) };
}

async function upToConsent() {
  const { tools, session } = harness();
  await tools.execute('provide_email', { email: 'ananya@example.com' }, session);
  await tools.execute('select_language', { language: 'en' }, session);
  await tools.execute('record_time_consent', { proceed: true }, session);
  expect(session.state).toBe(STATES.CONSENT_RECORDING);
  return { tools, session };
}

// 10 - "No code path exists that places an outbound call. Verified by review."
// Made mechanical, because a reviewer will not re-check it on every future PR.
describe('3.1 Pratibha never places an outbound call', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(SRC);

  it('never imports a telephony SDK capable of dialling', () => {
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
      expect(imports, file).not.toContain('plivo');
      expect(imports, file).not.toContain('twilio');
    }
  });

  it('never references a call-creation endpoint', () => {
    // The worker legitimately creates InterviewCall rows via prisma.interviewCall.create.
    // These patterns are scoped to actual telephony REST endpoints, not DB rows.
    const forbidden = [/api\.plivo\.com/i, /\/Call\//, /\bCalls?\.create\s*\(/i, /makeCall/i, /\bdial\(/i];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${file} matches ${pattern}`).toBe(false);
      }
    }
  });

  it('holds no credential that could authenticate an outbound call', () => {
    const source = fs.readFileSync(path.join(SRC, 'config', 'index.js'), 'utf8');
    expect(source).not.toMatch(/authId|auth_id|PLIVO_AUTH_ID/);
  });

  it('offers the model no tool that schedules a callback', () => {
    const everyTool = new Set(Object.values(TOOLS_BY_STATE).flat());
    for (const name of everyTool) {
      expect(name).not.toMatch(/call_?back|schedule|dial|reschedule/i);
    }
  });
});

// 3.2 / 10 - "ai_disclosure_given is true on every completed call."
describe('3.2 AI disclosure', () => {
  it('states plainly that Pratibha is an AI and not a human', () => {
    expect(DISCLOSURE).toMatch(/AI hiring assistant/i);
    expect(DISCLOSURE).toMatch(/not a human/i);
  });

  it('is a fixed string, so no model output can replace it', () => {
    const source = fs.readFileSync(path.join(SRC, 'lib', 'screening.js'), 'utf8');
    expect(source).toMatch(/export const DISCLOSURE\s*=\s*\n?\s*["']/);
  });

  it('can be personalised with tenant and job when the caller is known', () => {
    const session = {
      tenant: { name: 'ProMonkey Technologies' },
      job: { title: 'Senior Backend Engineer' },
      candidate: { name: 'Ananya' },
    };
    const disclosure = makeDisclosure(session);
    expect(disclosure).toMatch(/ProMonkey Technologies/);
    expect(disclosure).toMatch(/Senior Backend Engineer/);
    expect(disclosure).toMatch(/AI hiring assistant/i);
  });

  it('is spoken before the model is ever consulted', () => {
    const source = fs.readFileSync(path.join(SRC, 'lib', 'callSession.js'), 'utf8');
    const disclosureAt = source.indexOf('makeDisclosure');
    const firstTurnAt = source.indexOf('agent.runTurn');
    expect(disclosureAt).toBeGreaterThan(-1);
    expect(disclosureAt).toBeLessThan(firstTurnAt);
  });

  it('is only marked given once Plivo confirms the audio played', () => {
    const source = fs.readFileSync(path.join(SRC, 'lib', 'callSession.js'), 'utf8');
    const body = source.match(/#onPlayed\(segment\)\s*\{([\s\S]*?)\n  \}/);
    expect(body, 'could not find the #onPlayed method').not.toBeNull();
    expect(body[1]).toMatch(/aiDisclosureGiven = true/);

    const occurrences = source.match(/aiDisclosureGiven = true/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });
});

// 3.7 / 10 - caller recognition (phone/email) gates the line.
describe('3.7 caller recognition gates the line', () => {
  it('has no transition into SCREEN that skips recognition or consent', () => {
    expect(canTransition(STATES.GREET, STATES.SCREEN)).toBe(false);
    expect(canTransition(STATES.IDENTIFY, STATES.SCREEN)).toBe(false);
    expect(canTransition(STATES.LANGUAGE_SELECT, STATES.SCREEN)).toBe(false);
    expect(canTransition(STATES.CONSENT_TIME, STATES.SCREEN)).toBe(false);
    expect(canTransition(STATES.CONSENT_RECORDING, STATES.SCREEN)).toBe(true);
  });

  it('leaves an unrecognised session failing the verification check', () => {
    const { session } = harness();
    expect(isVerified(session)).toBe(false);
  });

  it('refuses a tool that does not belong to the current state', async () => {
    const { tools, session } = harness();
    const result = await tools.execute('finish_screening', { criteria_covered: [1] }, session);
    expect(result.error).toBeDefined();
    expect(session.state).toBe(STATES.IDENTIFY);
  });

  it('attaches candidate and moves to language selection on a recognised email', async () => {
    const { tools, session } = harness();
    const result = await tools.execute('provide_email', { email: 'ananya@example.com' }, session);

    expect(result.recognised).toBe(true);
    expect(session.candidate.id).toBe('c1');
    expect(session.job.title).toBe('Senior Backend Engineer');
    expect(session.state).toBe(STATES.LANGUAGE_SELECT);
    expect(db.recordInterviewCall).toHaveBeenCalledOnce();
  });

  it('ends the call when the email is not on the shortlist', async () => {
    db.lookupCandidateByEmail.mockResolvedValue(null);
    const { tools, session } = harness(null);
    const result = await tools.execute('provide_email', { email: 'ghost@example.com' }, session);

    expect(result.recognised).toBe(false);
    expect(session.ended).toBe(true);
    expect(session.outcome).toBe(TERMINAL.UNKNOWN_CALLER);
    expect(db.recordInterviewCall).not.toHaveBeenCalled();
  });

  it('cannot file a completed screening for a caller who never verified', async () => {
    const { tools, session } = harness();
    session.state = STATES.CANDIDATE_QA;
    await tools.execute('end_call', { outcome: 'completed' }, session);
    expect(session.outcome).toBe(TERMINAL.UNKNOWN_CALLER);
  });
});

// 3.3 / 10 - "Recording consent is captured and honoured; declining does not end the call."
describe('3.3 recording consent', () => {
  it('starts no recording until consent is granted', async () => {
    const { session } = await upToConsent();
    expect(session.recordingStarted).toBe(false);
    expect(session.recordingConsent).toBeNull();
  });

  it('records and honours a grant', async () => {
    const { tools, session } = await upToConsent();
    const result = await tools.execute('record_recording_consent', { granted: true }, session);
    expect(result.recording).toBe(true);
    expect(session.recordingConsent).toBe('granted');
    expect(session.recordingStarted).toBe(true);
  });

  it('continues the screening when the candidate declines', async () => {
    const { tools, session } = await upToConsent();
    const result = await tools.execute('record_recording_consent', { granted: false }, session);

    expect(result.recording).toBe(false);
    expect(session.recordingConsent).toBe('declined');
    expect(session.recordingStarted).toBe(false);
    expect(session.ended).toBe(false);
    expect(session.state).toBe(STATES.SCREEN);
  });
});

// 3.1 / 8.2 - a candidate who cannot talk is told to call back. Nothing is booked.
describe('8.2 "not a good time"', () => {
  it('ends with call_back_later and offers no callback', async () => {
    const { tools, session } = harness();
    await tools.execute('provide_email', { email: 'ananya@example.com' }, session);
    await tools.execute('select_language', { language: 'en' }, session);
    const result = await tools.execute('record_time_consent', { proceed: false }, session);

    expect(session.outcome).toBe(TERMINAL.CALL_BACK_LATER);

    expect(result.say_exactly).toMatch(/call this same number back/i);
    expect(result.say_exactly).not.toMatch(/we'?ll (call|ring|phone)|call you back|someone will call/i);
    expect(result).not.toHaveProperty('callback_at');
  });
});

// 8.6 / 3.1 - asked to phrase this itself, the model offered to fetch a person,
// which reads as a transfer. Nothing in this system can transfer or dial.
describe('8.6 escalation wording is fixed, not generated', () => {
  const categories = ['asked_for_human', 'hostile_or_distressed', 'line_quality', 'identity_mismatch', 'other'];

  it.each(categories)('gives %s a verbatim line that promises only email', async (category) => {
    const { tools, session } = harness();
    session.state = STATES.CONSENT_TIME;
    const result = await tools.execute('escalate', { category, reason: 'test' }, session);

    expect(typeof result.say_exactly).toBe('string');
    expect(result.say_exactly.length).toBeGreaterThan(20);
    expect(result).not.toHaveProperty('instruction');

    expect(result.say_exactly).not.toMatch(/transfer|put you through|hold the line|connect you/i);
    expect(result.say_exactly).not.toMatch(/call you back|someone will call|we'?ll ring|get someone/i);
    expect(session.outcome).toBe(TERMINAL.ESCALATED);
  });

  it('promises email follow-up wherever it promises follow-up at all', async () => {
    const { tools, session } = harness();
    session.state = STATES.CONSENT_TIME;
    const result = await tools.execute('escalate', { category: 'asked_for_human', reason: 'wants a person' }, session);
    expect(result.say_exactly).toMatch(/by email/i);
  });
});

// 3.4 / 3.5 / 10 - no unsupported score reaches the database, and nothing here rejects.
describe('3.5 scores must cite verifiable evidence', () => {
  let analyst; let saveReport; let session;

  beforeEach(() => {
    saveReport = vi.fn(async () => ({}));
    analyst = new PostCallAnalyst(config, logger, { getTemplate: vi.fn(async () => null), saveReport });
    session = {
      id: 'call-1',
      interviewCallId: 'ic-1',
      tenant: { name: 'ProMonkey Technologies' },
      job: { title: 'Senior Backend Engineer', mustHaves: ['Backend depth'], goodToHaves: [] },
      latestApprovedJd: { bodyMd: 'Backend' },
      candidate: { name: 'Ananya', cvParsed: { experience: 'Six years Node.js' } },
      criteria: [
        { id: 1, criterion: 'Backend depth', weight: 5 },
      ],
      transcript: {
        entries: [
          { kind: 'pratibha', text: 'Tell me about the payments integration.' },
          { kind: 'caller', text: 'I rebuilt the settlement service in Node and cut reconciliation time from six hours to twenty minutes.' },
          { kind: 'pratibha', text: 'And the team you led?' },
          { kind: 'caller', text: 'There were four of us and I ran the code reviews.' }
        ]
      }
    };
  });

  const stub = (input) => {
    analyst.anthropic = {
      messages: { create: async () => ({ content: [{ type: 'tool_use', name: 'submit_assessment', input }], usage: {} }) }
    };
  };

  it('keeps a score whose quote is really in the transcript', async () => {
    stub({
      scores: [{ criterion_id: 1, score: 4, evidence_quote: 'I rebuilt the settlement service in Node', reasoning: 'Concrete production work.' }],
      strengths: ['Production Node.js depth'], gaps: [], recommendation: 'pursue', recommendation_reasoning: 'Strong.'
    });

    const result = await analyst.analyse(session);
    expect(result.scores).toHaveLength(1);
    expect(result.dropped_scores).toBe(0);
    expect(saveReport).toHaveBeenCalledOnce();
  });

  it('drops a fabricated quote rather than filing it as evidence', async () => {
    stub({
      scores: [{ criterion_id: 1, score: 5, evidence_quote: 'I have architected systems at massive scale for a decade', reasoning: 'Very strong.' }],
      strengths: [], gaps: [], recommendation: 'pursue', recommendation_reasoning: 'Strong.'
    });

    const result = await analyst.analyse(session);
    expect(result.scores).toHaveLength(0);
    expect(result.dropped_scores).toBe(1);
    expect(result.not_assessed.map(n => n.criterion_id)).toContain(1);
  });

  it('drops a score against a criterion that is not on this job', async () => {
    stub({
      scores: [{ criterion_id: 99, score: 5, evidence_quote: 'There were four of us and I ran the code reviews', reasoning: 'x' }],
      strengths: [], gaps: [], recommendation: 'hold', recommendation_reasoning: 'x'
    });

    const result = await analyst.analyse(session);
    expect(result.scores).toHaveLength(0);
  });

  it('can only ever recommend, never reject', async () => {
    stub({
      scores: [], strengths: [], gaps: [],
      recommendation: 'rejected', recommendation_reasoning: 'No.'
    });

    const result = await analyst.analyse(session);
    expect(result.recommendation).toBe('hold');
    expect(['pursue', 'hold', 'do_not_pursue']).toContain(result.recommendation);
    expect(saveReport.mock.calls[0][0].recommendation).toBe('maybe');
  });

  it('never asks the database to set an application to rejected', () => {
    const source = fs.readFileSync(path.join(SRC, 'lib', 'analysis.js'), 'utf8') +
      fs.readFileSync(path.join(SRC, 'lib', 'toolExecutor.js'), 'utf8');
    expect(source).not.toMatch(/status['"]?\s*:\s*['"]rejected/);
  });
});

// 4.3 / 10 - "Calls outside operating hours receive the recorded message, not a dead line."
describe('4.3 operating hours', () => {
  const at = (iso) => new Date(iso);

  it('is open on a Tuesday afternoon IST', () => {
    expect(isWithinOperatingHours(config.operatingHours, at('2026-09-01T09:00:00Z'))).toBe(true);
  });

  it('is closed before 10 a.m. IST', () => {
    expect(isWithinOperatingHours(config.operatingHours, at('2026-09-01T03:00:00Z'))).toBe(false);
  });

  it('is closed after 7 p.m. IST', () => {
    expect(isWithinOperatingHours(config.operatingHours, at('2026-09-01T14:00:00Z'))).toBe(false);
  });

  it('is closed on Sunday', () => {
    expect(isWithinOperatingHours(config.operatingHours, at('2026-09-06T09:00:00Z'))).toBe(false);
  });

  describe('around the clock, Monday to Friday', () => {
    const allDay = { timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5], startHour: 0, endHour: 24 };

    it('is open in the small hours of a weekday', () => {
      expect(isWithinOperatingHours(allDay, at('2026-08-31T21:00:00Z'))).toBe(true);
    });

    it('is open at midday on a Friday', () => {
      expect(isWithinOperatingHours(allDay, at('2026-09-04T09:00:00Z'))).toBe(true);
    });

    it('is closed all weekend', () => {
      expect(isWithinOperatingHours(allDay, at('2026-09-05T09:00:00Z'))).toBe(false);
      expect(isWithinOperatingHours(allDay, at('2026-09-06T09:00:00Z'))).toBe(false);
    });

    it('tells callers the days, not a start and end time that never opens', () => {
      expect(describeHours(allDay)).toBe('Monday to Friday, twenty four hours a day');
    });
  });

  it('derives what callers are told from the hours actually enforced', () => {
    expect(describeHours({ days: [1, 2, 3, 4, 5, 6], startHour: 10, endHour: 19 }))
      .toBe('Monday to Saturday, 10 a.m. to 7 p.m.');
    expect(describeHours({ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }))
      .toBe('Monday to Friday, 9 a.m. to 6 p.m.');
    expect(describeHours({ days: [6], startHour: 11, endHour: 14 }))
      .toBe('on Saturdays, 11 a.m. to 2 p.m.');
    expect(describeHours({ days: [1, 3, 5], startHour: 10, endHour: 19 }))
      .toBe('Monday, Wednesday, Friday, 10 a.m. to 7 p.m.');
  });

  it('answers a closed-hours call with the hours rather than hanging up silently', () => {
    const xml = closedXml(config);
    expect(xml).toMatch(/<Speak/);
    expect(xml).toContain('Monday to Saturday');
    expect(xml).toMatch(/<Hangup\/>/);
  });
});

describe('Plivo answer document', () => {
  it('streams only the caller audio, so Pratibha never hears herself', () => {
    expect(streamXml(config, 'abc-123')).toContain('audioTrack="inbound"');
  });

  it('opens a bidirectional mu-law 8k stream and carries the call id', () => {
    const xml = streamXml(config, 'abc-123');
    expect(xml).toContain('bidirectional="true"');
    expect(xml).toContain('audio/x-mulaw;rate=8000');
    expect(xml).toContain('callUUID=abc-123');
  });
});

// The dead-air filler exists so a silent model never leaves a live call in silence.
describe('dead-air filler only covers real silence', () => {
  it('stays quiet when the turn already spoke before ending the call', async () => {
    const { ScreeningAgent } = await import('../src/lib/screening.js');
    const { SessionManager } = await import('../src/lib/sessionManager.js');

    const { tools, session } = harness();
    const agent = new ScreeningAgent(config, logger, tools);

    const replies = [
      { content: [
        { type: 'text', text: 'Thanks for your time, Ananya. The team will be in touch by email.' },
        { type: 'tool_use', id: 'tu1', name: 'end_call', input: { outcome: 'unknown_caller' } }
      ], stop_reason: 'tool_use' },
      { content: [], stop_reason: 'end_turn' }
    ];
    agent.anthropic = { messages: { create: async () => replies.shift() } };

    const said = [];
    await agent.runTurn(session, async (text) => { said.push(text); return text; });

    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/Thanks for your time/);
    expect(said.join(' ')).not.toMatch(/didn't quite catch/);
  });

  it('still fills real dead air when the model says nothing at all', async () => {
    const { ScreeningAgent } = await import('../src/lib/screening.js');

    const { tools, session } = harness();
    const agent = new ScreeningAgent(config, logger, tools);
    agent.anthropic = { messages: { create: async () => ({ content: [], stop_reason: 'end_turn' }) } };

    const said = [];
    await agent.runTurn(session, async (text) => { said.push(text); return text; });

    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/didn't quite catch/);
  });
});

// A screening line that answers and then fails is worse than one that never
// started: the candidate has used their one attempt on a broken call.
describe('configuration is checked at boot, not on the first call', () => {
  const complete = {
    mockMode: false,
    anthropic: { apiKey: 'a' },
    stt: { apiKey: 's' },
    tts: { provider: 'sarvam', apiKey: 's', elevenlabs: {} },
    os: { apiBase: 'https://os', serviceToken: 't', hmacSecret: 'h' },
    plivo: { verifySignature: true, authToken: 'p' },
    publicWsUrl: 'wss://hiring.promonkey.tech/pratibha/stream'
  };

  it('passes a complete configuration', async () => {
    const { validateConfig } = await import('../src/config/index.js');
    expect(validateConfig(complete)).toEqual([]);
  });

  it('names each missing credential', async () => {
    const { validateConfig } = await import('../src/config/index.js');
    const problems = validateConfig({
      ...complete,
      anthropic: { apiKey: '' },
      stt: { apiKey: '' },
      os: { apiBase: '', serviceToken: '', hmacSecret: '' }
    });
    expect(problems.join(' ')).toMatch(/ANTHROPIC_API_KEY/);
    expect(problems.join(' ')).toMatch(/SARVAM_API_KEY/);
  });

  it('catches signature verification switched on with no token', async () => {
    const { validateConfig } = await import('../src/config/index.js');
    const problems = validateConfig({ ...complete, plivo: { verifySignature: true, authToken: '' } });
    expect(problems.join(' ')).toMatch(/PLIVO_AUTH_TOKEN/);
    expect(problems.join(' ')).toMatch(/every call would be rejected/);
  });

  it('catches a non-TLS stream URL, which Plivo will not dial', async () => {
    const { validateConfig } = await import('../src/config/index.js');
    const problems = validateConfig({ ...complete, publicWsUrl: 'ws://hiring.promonkey.tech/pratibha/stream' });
    expect(problems.join(' ')).toMatch(/wss:\/\//);
  });

  describe('the chosen voice vendor', () => {
    const elevenlabs = {
      provider: 'elevenlabs',
      apiKey: '',
      elevenlabs: { apiKey: 'e', voiceId: 'v', outputFormat: 'ulaw_8000' }
    };

    it('accepts ElevenLabs configured without any Sarvam TTS key', async () => {
      const { validateConfig } = await import('../src/config/index.js');
      expect(validateConfig({ ...complete, tts: elevenlabs })).toEqual([]);
    });

    it('names the ElevenLabs credentials it needs, and only when it needs them', async () => {
      const { validateConfig } = await import('../src/config/index.js');
      const problems = validateConfig({
        ...complete,
        tts: { ...elevenlabs, elevenlabs: { apiKey: '', voiceId: '', outputFormat: 'ulaw_8000' } }
      });
      expect(problems.join(' ')).toMatch(/ELEVENLABS_API_KEY/);
      expect(problems.join(' ')).toMatch(/ELEVENLABS_VOICE_ID/);
      expect(problems.join(' ')).not.toMatch(/TTS_PROVIDER=sarvam/);
    });

    it('refuses an output format Plivo would play as static', async () => {
      const { validateConfig } = await import('../src/config/index.js');
      const problems = validateConfig({
        ...complete,
        tts: { ...elevenlabs, elevenlabs: { ...elevenlabs.elevenlabs, outputFormat: 'mp3_44100_128' } }
      });
      expect(problems.join(' ')).toMatch(/ELEVENLABS_OUTPUT_FORMAT/);
    });

    it('refuses a provider name nothing implements', async () => {
      const { validateConfig } = await import('../src/config/index.js');
      const problems = validateConfig({ ...complete, tts: { provider: 'polly', elevenlabs: {} } });
      expect(problems.join(' ')).toMatch(/TTS_PROVIDER is "polly"/);
    });
  });

  it('does not demand ProMonkey OS credentials in mock mode', async () => {
    const { validateConfig } = await import('../src/config/index.js');
    const problems = validateConfig({
      ...complete, mockMode: true, os: { apiBase: '', serviceToken: '', hmacSecret: '' }
    });
    expect(problems).toEqual([]);
  });
});

describe('streamXml carries the caller number', () => {
  /**
   * Plivo's WebSocket `start` event contains streamId, callId and callUUID —
   * but no caller number. It is only ever given to us on the answer webhook, so
   * it has to be handed to the stream explicitly. Without this, every real
   * caller arrived anonymous, failed recognition, and was sent down the
   * unknown-caller path — caller recognition never fired on a live call.
   */
  const cfg = {
    publicWsUrl: 'wss://example.ngrok-free.dev/pratibha/stream',
    publicBaseUrl: 'https://example.ngrok-free.dev',
  };

  it('puts the From number on the stream URL', () => {
    const xml = streamXml(cfg, 'call-1', '918076734039');
    expect(xml).toContain('callUUID=call-1');
    expect(xml).toContain('from=918076734039');
  });

  it('omits from when the webhook gave no caller number', () => {
    expect(streamXml(cfg, 'call-1')).not.toContain('from=');
  });

  it('escapes the URL into valid XML', () => {
    const xml = streamXml(cfg, 'call-1', '918076734039');
    expect(xml).toContain('&amp;');
    expect(xml).not.toMatch(/[^&]&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe('identity is withheld until the caller proves it', () => {
  /**
   * Greeting a recognised caller by name before verifying them hands their
   * identity to whoever is holding the phone, and makes the email check that
   * follows almost pointless — the hard part has already been given away.
   * Numbers get reassigned, phones get shared, and inbound caller ID is
   * spoofable, so the number alone is not proof.
   */
  const session = (state, extra = {}) => ({
    state,
    tenant: { name: 'Acme Corp' },
    job: { title: 'Senior Backend Engineer' },
    candidate: { name: 'Deepak', email: 'deepak@promonkey.tech' },
    ...extra,
  });

  it('does not say the name while verification is pending', () => {
    const s = session(STATES.VERIFY_EMAIL);
    const said = makeDisclosure(s, { personalise: false });
    expect(said).not.toContain('Deepak');
    expect(said).toContain('Acme Corp');
    // The mandatory disclosure still has to be spoken in full.
    expect(said).toContain('not a human');
    expect(said).toContain('recorded');
  });

  it('uses the name once verification has passed', () => {
    const s = session(STATES.LANGUAGE_SELECT, { emailVerified: true });
    expect(makeDisclosure(s)).toContain('Deepak');
  });

  it('treats a verified caller, and only a verified caller, as confirmed', () => {
    expect(identityConfirmed(session(STATES.VERIFY_EMAIL))).toBe(false);
    expect(identityConfirmed(session(STATES.VERIFY_EMAIL, { emailVerified: true }))).toBe(true);
    // Verification disabled: the flow never enters VERIFY_EMAIL at all.
    expect(identityConfirmed(session(STATES.LANGUAGE_SELECT))).toBe(true);
  });
});
