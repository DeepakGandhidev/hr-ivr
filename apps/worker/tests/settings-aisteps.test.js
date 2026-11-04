import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSettings, __resetSettingsRuntime } from '@pratibha/shared/settings-runtime';
import { SETTINGS, SETTINGS_BY_KEY, validateSettingValue } from '@pratibha/shared/settings-registry';
import { STATES } from '../src/lib/states.js';
import {
  TOOL_DEFINITIONS,
  ToolExecutor,
  fillStep,
  languagesSpoken,
  offeredLanguages,
  toolDefinition,
} from '../src/lib/toolExecutor.js';
import { ScreeningAgent, languageHintFor, stageGuidance } from '../src/lib/screening.js';
import { deriveCriteria } from '../src/lib/callSession.js';

vi.mock('../src/db/index.js', () => ({
  lookupCandidateByPhone: vi.fn(),
  lookupCandidateByEmail: vi.fn(),
  recordInterviewCall: vi.fn(async () => ({ id: 'call-1' })),
  updateInterviewCall: vi.fn(async () => ({})),
  incrementInterviewUsage: vi.fn(async () => ({})),
}));

import * as db from '../src/db/index.js';

const quiet = { warn: () => {}, info: () => {} };
const withSettings = (rows) => startSettings({ app: 'worker', load: async () => rows, logger: quiet, intervalMs: 1e9 });
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const config = { operatingHours: { label: 'Monday to Saturday, 10 a.m. to 7 p.m.' } };

afterEach(() => __resetSettingsRuntime());

// The wording the worker used before these became settings, copied verbatim.
// A fresh deploy must tell the AI exactly this.
const OLD = {
  noEmailOnFile: 'Thank them and ask whether they would like to continue in English, Hindi, or Hinglish.',
  verified: 'Thank them by first name now that they are confirmed, then ask whether they would like to continue in English, Hindi, or Hinglish. Do not greet them again or re-introduce yourself.',
  alreadyInterviewed: 'Say you already have a completed interview on file for this role, thank them, and end the call warmly.',
  otherCandidate: 'This is a different candidate to the one the number is registered to, which is fine. Greet them by first name, confirm the role you have them down for, then ask whether they would like to continue in English, Hindi, or Hinglish. Do not re-introduce yourself.',
  exhausted: 'Say you were not able to confirm their details, that the team will follow up by email, thank them warmly, and end the call. Do not say what the correct address is.',
  retry: 'Say the line may have broken up, and ask them to say just the part of their email address before the "at" sign, slowly. Never suggest they gave the wrong address, never reveal the address on file, and never read any part of it back to them.',
  notFound: 'Politely say you cannot find an application under that email address, ask them to check it and apply again if needed, thank them, and end the call.',
  paused: 'Say interviews for this role are paused at the moment so you cannot go ahead today, that the team will be in touch by email, thank them, and end the call. Do not say why.',
  notShortlisted: 'Say you found the email but the candidate is not currently on the approved shortlist. Thank them and end the call.',
  found: 'Confirm their name and the role, then ask whether they would like to continue in English, Hindi, or Hinglish.',
  withdrawn: 'Thank them for letting us know and end the call warmly.',
  proceed: 'Now ask for permission to record the call so the team can review their answers properly.',
  granted: 'Thank them and begin the screening questions.',
  declined: 'Tell them that is absolutely fine, you will not record and will take notes instead, then begin the screening questions.',
  recorded: 'Thank them neutrally and move on. Do not comment on the answer.',
  salaryCheck: 'Then record their answer with field band_answer and carry on.',
  salaryNoted: 'Thank them neutrally and move on. Do not mention the band.',
  withQuestions: 'Tell them that is everything from your side and ask whether they have any questions about the role or the company.',
  withoutQuestions: 'Tell them that is everything from your side, close the call as your closing instructions say, and call end_call.',
  stage: {
    [STATES.IDENTIFY]: 'Their number is not on the shortlist. Ask which email address they applied with, then pass exactly what they say to provide_email.',
    [STATES.VERIFY_EMAIL]:
      'A greeting has been spoken and you are confirming who the caller is. Ask which email address they applied with, then pass exactly what they say to confirm_email. ' +
      'You have not been told their name and must not use one, or ask them to confirm a name. Never read the address on file aloud, never spell any part of it, and never hint at it - they must produce it. Ask once, warmly, in one sentence.',
    [STATES.LANGUAGE_SELECT]: 'Ask which language they would like: English, Hindi, or Hinglish. Then call select_language.',
    [STATES.CONSENT_RECORDING]: 'Ask for permission to record before any interview question.',
    [STATES.CANDIDATE_QA]: 'Invite any questions they have about the role or the process.',
  },
  closeOnly: 'Screening is finished. Close the call now as your closing instructions say, then call end_call.',
  unverified:
    'Not yet established. Their number matches someone on the shortlist, but that only identifies the phone, not the person holding it.\n' +
    'You do NOT know their name, employer, or anything on their CV, and you must not guess or imply any of it. Do not use a name at all this turn.',
  wrapUp: 'Wrap up now and call finish_screening.',
  hint: {
    en: '- Conduct this conversation in English (Indian). Use simple words because the line is noisy.',
    hi: '- Conduct this conversation in Hindi.',
    hinglish: '- Conduct this conversation in Hinglish (Hindi words in Roman script, mixed with English).',
  },
};

const lookup = (extra = {}) => ({
  candidate: { id: 'c1', name: 'Ananya', email: 'ananya@example.com' },
  job: { id: 'j1', title: 'Backend Engineer', mustHaves: ['Node.js'], goodToHaves: ['AWS'], salaryMin: 1_000_000, salaryMax: 1_500_000 },
  tenant: { id: 't1', name: 'Acme', status: 'active' },
  interviewProtocol: {},
  approved: true,
  hasCompleted: false,
  ...extra,
});

function session(state, extra = {}) {
  return {
    id: 's1',
    state,
    history: [],
    questionsAsked: 0,
    setState(next) { this.state = next; },
    finish(outcome) { this.ended = true; this.outcome = outcome; },
    ...extra,
  };
}

const tools = (overrides = {}) => new ToolExecutor({ ...config, ...overrides }, logger);

describe('the ai_steps registry', () => {
  const steps = SETTINGS.filter((d) => d.group === 'ai_steps');

  it('is well formed and every default passes its own validation', () => {
    expect(steps.length).toBeGreaterThan(30);
    for (const def of steps) {
      expect(def.key.startsWith('ai_steps.')).toBe(true);
      expect(def.apps).toEqual(['worker']);
      expect(def.applies).toBe('next_call');
      expect(def.help).toBeTruthy();
      expect(validateSettingValue(def, def.default)).toEqual({ ok: true, value: def.default });
    }
  });

  it('has a description setting for every tool, and only for real tools', () => {
    const toolKeys = steps.filter((d) => d.key.startsWith('ai_steps.tool.')).map((d) => d.key.slice('ai_steps.tool.'.length));
    expect(toolKeys.sort()).toEqual(Object.keys(TOOL_DEFINITIONS).sort());
  });
});

describe('with nothing saved, the AI is told exactly what it was told before', () => {
  it('confirm_email outcomes', async () => {
    vi.clearAllMocks();
    const t = tools();

    let s = session(STATES.VERIFY_EMAIL, { candidate: { id: 'c1', name: 'Ananya' } });
    expect((await t.execute('confirm_email', { email: 'x@y.com' }, s)).instruction).toBe(OLD.noEmailOnFile);

    s = session(STATES.VERIFY_EMAIL, { candidate: { id: 'c1', name: 'Ananya', email: 'ananya@example.com' } });
    expect((await t.execute('confirm_email', { email: 'ananya@example.com' }, s)).instruction).toBe(OLD.verified);

    db.lookupCandidateByEmail.mockResolvedValue(lookup({ candidate: { id: 'c2', name: 'Ravi' }, hasCompleted: true }));
    s = session(STATES.VERIFY_EMAIL, { candidate: { id: 'c1', name: 'Ananya', email: 'ananya@example.com' } });
    expect((await t.execute('confirm_email', { email: 'ravi@example.com' }, s)).instruction).toBe(OLD.alreadyInterviewed);

    db.lookupCandidateByEmail.mockResolvedValue(lookup({ candidate: { id: 'c2', name: 'Ravi' } }));
    s = session(STATES.VERIFY_EMAIL, { candidate: { id: 'c1', name: 'Ananya', email: 'ananya@example.com' } });
    expect((await t.execute('confirm_email', { email: 'ravi@example.com' }, s)).instruction).toBe(OLD.otherCandidate);

    db.lookupCandidateByEmail.mockResolvedValue(null);
    s = session(STATES.VERIFY_EMAIL, { candidate: { id: 'c1', name: 'Ananya', email: 'ananya@example.com' } });
    expect((await t.execute('confirm_email', { email: 'wrong@example.com' }, s)).instruction).toBe(OLD.retry);
    expect((await t.execute('confirm_email', { email: 'wrong@example.com' }, s)).instruction).toBe(OLD.exhausted);
  });

  it('provide_email outcomes', async () => {
    vi.clearAllMocks();
    db.lookupCandidateByEmail.mockResolvedValue(null);
    expect((await tools().execute('provide_email', { email: 'a@b.c' }, session(STATES.IDENTIFY))).instruction).toBe(OLD.notFound);

    db.lookupCandidateByEmail.mockResolvedValue(lookup({ tenant: { id: 't1', name: 'Acme', status: 'suspended' } }));
    expect((await tools().execute('provide_email', { email: 'a@b.c' }, session(STATES.IDENTIFY))).instruction).toBe(OLD.paused);

    db.lookupCandidateByEmail.mockResolvedValue(lookup({ approved: false }));
    expect((await tools({ requireShortlistApproval: true }).execute('provide_email', { email: 'a@b.c' }, session(STATES.IDENTIFY))).instruction).toBe(OLD.notShortlisted);

    db.lookupCandidateByEmail.mockResolvedValue(lookup({ hasCompleted: true }));
    expect((await tools().execute('provide_email', { email: 'a@b.c' }, session(STATES.IDENTIFY))).instruction).toBe(OLD.alreadyInterviewed);

    db.lookupCandidateByEmail.mockResolvedValue(lookup());
    expect((await tools().execute('provide_email', { email: 'a@b.c' }, session(STATES.IDENTIFY))).instruction).toBe(OLD.found);
  });

  it('consent outcomes', async () => {
    const t = tools();
    expect((await t.execute('record_time_consent', { proceed: false, withdrawn: true }, session(STATES.CONSENT_TIME))).instruction).toBe(OLD.withdrawn);
    expect((await t.execute('record_time_consent', { proceed: true }, session(STATES.CONSENT_TIME))).instruction).toBe(OLD.proceed);
    expect((await t.execute('record_recording_consent', { granted: true }, session(STATES.CONSENT_RECORDING))).instruction).toBe(OLD.granted);
    expect((await t.execute('record_recording_consent', { granted: false }, session(STATES.CONSENT_RECORDING))).instruction).toBe(OLD.declined);
  });

  it('screening outcomes', async () => {
    const t = tools();
    const job = lookup().job;
    expect((await t.execute('record_detail', { field: 'notice_period', value: '30 days' }, session(STATES.SCREEN, { job }))).instruction).toBe(OLD.recorded);

    const blocks = { blocks: { line_salary_check: 'The band is {{band}}. Could you work within that?' } };
    const check = await t.execute('record_detail', { field: 'expected_ctc', value: '40 lakh' },
      session(STATES.SCREEN, { job, promptBlocks: blocks, interviewProtocol: { mismatchAction: 'check' } }));
    expect(check.say_exactly).toMatch(/^The band is/);
    expect(check.instruction).toBe(OLD.salaryCheck);

    const noted = await t.execute('record_detail', { field: 'expected_ctc', value: '40 lakh' },
      session(STATES.SCREEN, { job, interviewProtocol: { mismatchAction: 'note' } }));
    expect(noted.instruction).toBe(OLD.salaryNoted);

    expect((await t.execute('finish_screening', { criteria_covered: [1] }, session(STATES.SCREEN))).instruction).toBe(OLD.withQuestions);
    expect((await t.execute('finish_screening', { criteria_covered: [1] }, session(STATES.SCREEN, { interviewProtocol: { candidateQuestions: false } }))).instruction).toBe(OLD.withoutQuestions);
  });

  it('criteria guidance', () => {
    const criteria = deriveCriteria(lookup().job);
    expect(criteria.map((c) => c.evaluation_guidance)).toEqual(['Must-have for this role.', 'Nice-to-have for this role.']);
  });

  it('tool definitions', () => {
    for (const name of Object.keys(TOOL_DEFINITIONS)) {
      expect(toolDefinition(name)).toEqual(TOOL_DEFINITIONS[name]);
    }
  });

  it('stage guidance and language lines', () => {
    for (const [state, text] of Object.entries(OLD.stage)) {
      expect(stageGuidance(session(state))).toBe(text);
    }
    expect(stageGuidance(session(STATES.CANDIDATE_QA, { interviewProtocol: { candidateQuestions: false } }))).toBe(OLD.closeOnly);
    expect(stageGuidance(session(STATES.SCREEN))).toBeNull();
    expect(languageHintFor(undefined)).toBe(OLD.hint.en);
    expect(languageHintFor('en')).toBe(OLD.hint.en);
    expect(languageHintFor('hi')).toBe(OLD.hint.hi);
    expect(languageHintFor('hinglish')).toBe(OLD.hint.hinglish);
  });

  it('system prompt fragments', () => {
    const agent = new ScreeningAgent({ anthropic: {} }, logger, tools());
    const unverified = agent.buildSystemPrompt(session(STATES.VERIFY_EMAIL, { candidate: { name: 'Ananya' }, job: { title: 'Backend Engineer' } }));
    expect(unverified).toContain(`WHO YOU ARE SPEAKING TO\n${OLD.unverified}\nApplying for: Backend Engineer`);
    expect(unverified).toContain(OLD.hint.en);

    const screening = agent.buildSystemPrompt(session(STATES.SCREEN, {
      candidate: { name: 'Ananya' }, job: { title: 'Backend Engineer' }, emailVerified: true, questionsAsked: 99,
    }));
    expect(screening).toContain(` ${OLD.wrapUp}`);
  });
});

describe('the consent stage states the real interview length', () => {
  it('uses the job length, else the platform default', async () => {
    expect(stageGuidance(session(STATES.CONSENT_TIME))).toBe('Ask whether now is a good time and say the call takes about 10 minutes.');
    expect(stageGuidance(session(STATES.CONSENT_TIME, { interviewProtocol: { durationMinutes: 25 } })))
      .toBe('Ask whether now is a good time and say the call takes about 25 minutes.');

    const result = await tools().execute('select_language', { language: 'hi' }, session(STATES.LANGUAGE_SELECT, { interviewProtocol: { durationMinutes: 20 } }));
    expect(result.instruction).toBe('Confirm the language choice, say the call takes about 20 minutes, and ask whether now is a good time.');

    await withSettings([{ key: 'calls.default_duration_minutes', value: 15 }]);
    expect(stageGuidance(session(STATES.CONSENT_TIME))).toBe('Ask whether now is a good time and say the call takes about 15 minutes.');
  });
});

describe('saved steps reach the AI', () => {
  it('uses a saved value and fills its placeholders', async () => {
    await withSettings([
      { key: 'ai_steps.confirm_email.verified', value: 'Welcome {name}. Offer {languages}. Keep {unknown} as typed.' },
      { key: 'ai_steps.confirm_email.retry', value: 'Ask again; {attempts_left} left.' },
      { key: 'ai_steps.provide_email.found', value: '{name} applied for {job_title}.' },
      { key: 'ai_steps.select_language.chosen', value: 'They chose {language}; it takes {minutes} minutes.' },
      { key: 'ai_steps.stage.consent_recording', value: 'Ask to record, briefly.' },
      { key: 'ai_steps.tool.end_call', value: 'Hang up when done.' },
      { key: 'ai_steps.criteria.must_have_guidance', value: 'Essential.' },
    ]);
    vi.clearAllMocks();
    const t = tools();

    let s = session(STATES.VERIFY_EMAIL, { candidate: { id: 'c1', name: 'Ananya', email: 'ananya@example.com' } });
    expect((await t.execute('confirm_email', { email: 'ananya@example.com' }, s)).instruction)
      .toBe('Welcome Ananya. Offer English, Hindi, or Hinglish. Keep {unknown} as typed.');

    db.lookupCandidateByEmail.mockResolvedValue(null);
    s = session(STATES.VERIFY_EMAIL, { candidate: { id: 'c1', name: 'Ananya', email: 'ananya@example.com' } });
    expect((await t.execute('confirm_email', { email: 'wrong@example.com' }, s)).instruction).toBe('Ask again; 1 left.');

    db.lookupCandidateByEmail.mockResolvedValue(lookup());
    expect((await t.execute('provide_email', { email: 'a@b.c' }, session(STATES.IDENTIFY))).instruction).toBe('Ananya applied for Backend Engineer.');

    expect((await t.execute('select_language', { language: 'hinglish' }, session(STATES.LANGUAGE_SELECT))).instruction)
      .toBe('They chose Hinglish; it takes 10 minutes.');

    expect(stageGuidance(session(STATES.CONSENT_RECORDING))).toBe('Ask to record, briefly.');
    expect(toolDefinition('end_call').description).toBe('Hang up when done.');
    expect(toolDefinition('end_call').input_schema).toEqual(TOOL_DEFINITIONS.end_call.input_schema);
    expect(deriveCriteria(lookup().job)[0].evaluation_guidance).toBe('Essential.');
  });

  it('falls back to the default when a value is emptied', async () => {
    await withSettings([
      { key: 'ai_steps.time_consent.proceed', value: '' },
      { key: 'ai_steps.stage.identify', value: '   ' },
      { key: 'ai_steps.tool.escalate', value: '' },
    ]);
    expect((await tools().execute('record_time_consent', { proceed: true }, session(STATES.CONSENT_TIME))).instruction).toBe(OLD.proceed);
    expect(stageGuidance(session(STATES.IDENTIFY))).toBe(OLD.stage[STATES.IDENTIFY]);
    expect(toolDefinition('escalate')).toEqual(TOOL_DEFINITIONS.escalate);
  });

  it('fills a missing value as empty rather than leaving the placeholder', () => {
    expect(fillStep('Hi {name}.', { name: null })).toBe('Hi .');
    expect(fillStep('Hi {name}.', {})).toBe('Hi {name}.');
  });
});

describe('interview languages offered', () => {
  it('offers all three by default', () => {
    expect(offeredLanguages()).toEqual(['en', 'hi', 'hinglish']);
    expect(languagesSpoken()).toBe('English, Hindi, or Hinglish');
    expect(SETTINGS_BY_KEY['ai_steps.languages'].default).toEqual(['en', 'hi', 'hinglish']);
  });

  it('drops unknown codes and narrows the tool, the wording and what is accepted', async () => {
    await withSettings([{ key: 'ai_steps.languages', value: ['hi', 'tamil', 'EN'] }]);
    expect(offeredLanguages()).toEqual(['hi', 'en']);
    expect(languagesSpoken()).toBe('Hindi or English');
    expect(stageGuidance(session(STATES.LANGUAGE_SELECT))).toBe('Ask which language they would like: Hindi or English. Then call select_language.');

    const def = toolDefinition('select_language');
    expect(def.input_schema.properties.language.enum).toEqual(['hi', 'en']);
    expect(def.description).toBe('Record the language the caller wants for the interview: Hindi or English.');
    // The shipped definition is untouched.
    expect(TOOL_DEFINITIONS.select_language.input_schema.properties.language.enum).toEqual(['en', 'hi', 'hinglish']);

    const s = session(STATES.LANGUAGE_SELECT);
    const refused = await tools().execute('select_language', { language: 'hinglish' }, s);
    expect(refused.error).toMatch(/not offered/);
    expect(s.state).toBe(STATES.LANGUAGE_SELECT);
    expect(s.language).toBeUndefined();
  });

  it('offers every language when nothing valid is saved', async () => {
    await withSettings([{ key: 'ai_steps.languages', value: ['tamil'] }]);
    expect(offeredLanguages()).toEqual(['en', 'hi', 'hinglish']);
  });

  it('reads one language on its own', async () => {
    await withSettings([{ key: 'ai_steps.languages', value: ['en'] }]);
    expect(languagesSpoken()).toBe('English');
  });
});
