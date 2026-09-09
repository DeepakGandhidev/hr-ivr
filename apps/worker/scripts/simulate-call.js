/**
 * Drives a scripted candidate through a whole call without Plivo or Sarvam.
 *
 * Uses the real v2 DB lookup, state machine, tool gating, model turns and
 * post-call analysis. Set ANTHROPIC_API_KEY in apps/worker/.env to exercise
 * the model; without it the call will start and then fail on the first turn.
 */
import 'dotenv/config';
import { EventEmitter } from 'events';
import pino from 'pino';

import { loadConfig } from '../src/config/index.js';
import { ToolExecutor } from '../src/lib/toolExecutor.js';
import { ScreeningAgent } from '../src/lib/screening.js';
import { PostCallAnalyst } from '../src/lib/analysis.js';
import { SessionManager } from '../src/lib/sessionManager.js';
import { CallTranscript } from '../src/lib/transcript.js';
import { CallSession } from '../src/lib/callSession.js';
import { isVerified } from '../src/lib/states.js';
import { MockSTT, MockTTS } from '../src/audio/mockSpeech.js';

const PHONE = process.argv[2] || '+919876543210';

// Verification asks the caller to say their own address, so the script cannot
// hard-code one — it is filled in per candidate below. Spoken the way someone
// actually reads an address down a phone line, since that is what the matcher
// has to cope with.
const EMAIL_PLACEHOLDER = '__CANDIDATE_EMAIL__';

function spokenEmail(address) {
  if (!address) return 'I do not have that to hand';
  return address.replace('@', ' at the rate ').replace(/\./g, ' dot ');
}

const SCRIPTS = {
  normal: [
    EMAIL_PLACEHOLDER,
    'English',
    'Yes, now is fine.',
    'Yes, you can record it.',
    'I have five years of backend experience, mostly with Node.js and PostgreSQL.',
    'At my current company I designed the payments API and migrated the ledger from MySQL to PostgreSQL.',
    'I have used Redis for caching and rate limiting, but I have not done much with Kubernetes.',
    'No questions from my side, thank you.',
    'No, nothing else. Thanks for your time.',
  ],
  busy: ['English', 'Sorry, I am driving, can I call back later?'],
  wrongemail: ['someone.else@gmail.com', 'nope@gmail.com'],
  // Calling from one candidate's phone but giving another approved
  // candidate's address — a borrowed handset.
  otherperson: ['kabir at the rate example dot com', 'English', 'Yes, now is fine.', 'Yes, you can record it.'],
  // Calling from an unrecognised phone and identifying by voice alone.
  byemail: [
    'ishita at the rate example dot com',
    'English', 'Yes, now is fine.', 'Yes, you can record it.',
    'I have eleven years of backend experience across Amazon and Razorpay.',
  ],
  human: ['English', 'Yes, now is fine.', 'Yes, you can record.', 'Actually, could I speak to a real person?'],
};

// Answers for after the script runs out. Deliberately concrete, so the model
// has something to probe rather than stonewalling into an escalation.
const FILLER = [
  'The hardest part was keeping the ledger consistent during the cutover, so we dual-wrote and backfilled before flipping reads.',
  'We caught it with a row-count reconciliation job that ran every five minutes against both databases.',
  'I owned the API contract and versioned it in the URL so the mobile clients could migrate on their own schedule.',
  'About forty million rows, and we did it with no downtime over a weekend.',
  'I was on call for that service, so I wrote the runbook and cut the alert noise by roughly half.',
  'That is about it from my side — happy to go into more detail on any of it.',
];

// Ceiling so a model that never wraps up cannot spin forever.
const MAX_SIM_TURNS = 24;

const which = process.argv[3] || 'normal';
const script = SCRIPTS[which];
if (!script) {
  console.error(`unknown scenario "${which}". one of: ${Object.keys(SCRIPTS).join(', ')}`);
  process.exit(1);
}

const config = loadConfig();

// Resolve the candidate so the script can say the right address.
const { lookupCandidateByPhone } = await import('../src/db/index.js');
const known = await lookupCandidateByPhone(PHONE);
for (const lines of Object.values(SCRIPTS)) {
  const at = lines.indexOf(EMAIL_PLACEHOLDER);
  if (at !== -1) lines[at] = spokenEmail(known?.candidate?.email);
}
const logger = pino({ level: process.env.SIM_LOG_LEVEL || 'info' });

if (!config.anthropic.apiKey) {
  console.error('\n❌ ANTHROPIC_API_KEY is not set. Add it to apps/worker/.env to run a simulated interview.\n');
  process.exit(1);
}

/** Stands in for PlivoStream. Confirms playback immediately. */
class FakePlivo extends EventEmitter {
  constructor() {
    super();
    this.played = [];
    this.spoken = [];
  }
  play(audio, text) {
    const id = `cp-${this.spoken.length}`;
    this.spoken.push(text);
    this.played.push(text);
    setImmediate(() => this.emit('played', { id, text }));
    return id;
  }

  /** The streaming path CallSession actually uses. */
  async playStream(chunks, { text, signal } = {}) {
    let queued = 0;
    for await (const chunk of chunks) {
      if (signal?.aborted) break;
      queued += chunk.length;
    }
    if (!queued || signal?.aborted) return null;
    return this.play(null, text);
  }
  clear() {
    const heard = this.played.join(' ');
    this.played = [];
    return { heard, dropped: '' };
  }
  get queuedMs() { return 0; }
  close() {}
}

const tools = new ToolExecutor(config, logger);
const agent = new ScreeningAgent(config, logger, tools);
const analyst = new PostCallAnalyst(config, logger);
const sessions = new SessionManager();

const session = sessions.create('sim-1', { callerNumber: PHONE });
session.transcript = new CallTranscript('sim-1', 'sim-1', logger);

const plivo = new FakePlivo();
const stt = new MockSTT(script);
const tts = new MockTTS();
const call = new CallSession({ plivo, session, agent, config, logger, analyst, stt, tts });

const show = (who, text) => console.log(`\n  ${who.padEnd(10)} ${text}`);

console.log(`\n${'='.repeat(78)}\n  SIMULATED CALL - scenario "${which}" for ${PHONE}`);
console.log(`  model: ${config.anthropic.model}   analysis: ${config.anthropic.analysisModel}\n${'='.repeat(78)}`);

let lastShown = 0;
const flush = () => {
  for (const line of plivo.spoken.slice(lastShown)) show('PRATIBHA', line);
  lastShown = plivo.spoken.length;
};

const started = Date.now();
try {
  await call.begin({ streamId: 's1', callUUID: 'sim-1', from: PHONE });
  flush();

  // Pratibha decides how many questions to ask (six to ten), so a fixed script
  // runs dry mid-interview and the call ends as `abandoned` — which is not
  // billable and never reaches Stage 9. After the script, keep answering with
  // filler so the run finishes the way a real completed interview does.
  const answers = [...script];
  let filler = 0;
  while (!session.ended && answers.length + filler < MAX_SIM_TURNS) {
    const line = answers.shift() ?? FILLER[filler++ % FILLER.length];
    show('CANDIDATE', line);
    const turnStart = Date.now();
    stt.say(line);
    await call.turnLock;
    flush();
    console.log(`  ${''.padEnd(10)} (turn took ${Date.now() - turnStart} ms)`);
    if (!answers.length && which !== 'normal') break;
  }

  await call.finalise(session.outcome);

  let assessment = null;
  if (isVerified(session) && session.questionsAsked > 0) {
    console.log('\n  running post-call analysis...');
    assessment = await analyst.analyse(session).catch((err) => {
      console.error('  analysis failed:', err.message);
      return null;
    });
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`  outcome              ${session.outcome}`);
  console.log(`  final state          ${session.state}`);
  console.log(`  AI disclosure given  ${session.aiDisclosureGiven}`);
  console.log(`  recording consent    ${session.recordingConsent ?? '(not reached)'}`);
  console.log(`  recognised           ${session.recognised}`);
  console.log(`  questions asked      ${session.questionsAsked}`);
  console.log(`  escalation           ${session.escalation ? session.escalation.category : 'none'}`);
  console.log(`  wall clock           ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (assessment) {
    console.log(`\n  ASSESSMENT (recommendation: ${assessment.recommendation})`);
    console.log(`  ${assessment.recommendation_reasoning}`);
    for (const score of assessment.scores) {
      const criterion = session.criteria.find((c) => c.id === score.criterion_id);
      console.log(`\n   - ${criterion?.criterion}: ${score.score}/5`);
      console.log(`     evidence: "${score.evidence_quote}"`);
    }
    for (const gap of assessment.not_assessed) {
      const criterion = session.criteria.find((c) => c.id === gap.criterion_id);
      console.log(`\n   - ${criterion?.criterion}: not scored - ${gap.reason}`);
    }
    console.log(`\n  scores dropped for unverifiable evidence: ${assessment.dropped_scores}`);
  }
  console.log(`${'='.repeat(78)}\n`);
} catch (err) {
  console.error('\n  simulation failed:', err.message);
  console.error(err.stack);
  process.exit(1);
}

process.exit(0);
