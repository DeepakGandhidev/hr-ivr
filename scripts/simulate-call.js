/**
 * Drives a scripted candidate through a whole call without Plivo or Sarvam.
 *
 * Everything above the two vendor sockets is real: the state machine, the tool
 * gate, the model turns, the barge-in bookkeeping and the post-call analysis.
 * What it cannot tell you is whether speech recognition copes with a real
 * candidate on a real line - section 4.1 is explicit that has to be measured on
 * recorded calls.
 *
 *   node scripts/simulate-call.js              a normal screening
 *   node scripts/simulate-call.js badcode      caller cannot give a valid code
 *   node scripts/simulate-call.js human        caller asks for a person
 *   node scripts/simulate-call.js busy         caller cannot talk now
 */
import 'dotenv/config';
import { EventEmitter } from 'events';
import pino from 'pino';

import { loadConfig } from '../src/config/index.js';
import { OsApi } from '../src/lib/osApi.js';
import { ToolExecutor } from '../src/lib/toolExecutor.js';
import { ScreeningAgent } from '../src/lib/screening.js';
import { PostCallAnalyst } from '../src/lib/analysis.js';
import { SessionManager } from '../src/lib/sessionManager.js';
import { CallTranscript } from '../src/lib/transcript.js';
import { CallSession } from '../src/lib/callSession.js';
import { MockSTT, MockTTS } from '../src/audio/mockSpeech.js';

const SCRIPTS = {
  normal: [
    'Hi, yes, my code is H7K294.',
    'Yes, now is fine.',
    "Yeah, that's alright, you can record it.",
    'Sure. So at Infosys I rebuilt the settlement service in Node, and we cut reconciliation time from about six hours down to twenty minutes.',
    'There were four of us on that team and I ran the code reviews and did the onboarding for two juniors.',
    'We used REST mostly, with an idempotency key on every write, because the payment gateway retried aggressively and we were double-charging people.',
    "Honestly no, I haven't used AWS much. We were on-prem for most of it.",
    'No questions from my side, thank you.',
    "No, nothing from me. Thanks for your time."
  ],
  badcode: ['My code is ZZZZZZ.', 'Sorry, let me try again, ZZZ999.'],
  human: ['My code is H7K294.', "Actually, could I just speak to a real person instead?"],
  busy: ['Code is H7K294.', "Sorry, I'm actually driving right now, can I call back later?"]
};

const which = process.argv[2] || 'normal';
const script = SCRIPTS[which];
if (!script) {
  console.error(`unknown scenario "${which}". one of: ${Object.keys(SCRIPTS).join(', ')}`);
  process.exit(1);
}

const config = { ...loadConfig(), mockMode: true };
const logger = pino({ level: process.env.SIM_LOG_LEVEL || 'silent' });

/** Stands in for PlivoStream. Confirms playback immediately, as a good line would. */
class FakePlivo extends EventEmitter {
  constructor() { super(); this.played = []; this.pending = []; this.spoken = []; }
  play(audio, text) {
    const id = `cp-${this.spoken.length}`;
    this.spoken.push(text);
    this.played.push(text);
    setImmediate(() => this.emit('played', { id, text }));
    return id;
  }
  clear() { const heard = this.played.join(' '); this.played = []; return { heard, dropped: '' }; }
  takeSpoken() { const s = this.played.join(' '); this.played = []; return s; }
  get queuedMs() { return 0; }
  close() {}
}

const api = new OsApi(config, logger);
const tools = new ToolExecutor(config, logger, api);
const agent = new ScreeningAgent(config, logger, tools);
const analyst = new PostCallAnalyst(config, logger, api);
const sessions = new SessionManager();

const session = sessions.create('sim-1', { callerNumber: '+919812345678' });
session.transcript = new CallTranscript('sim-1', 'sim-1', logger);

const plivo = new FakePlivo();
const stt = new MockSTT(script);
const tts = new MockTTS();
const call = new CallSession({ plivo, session, agent, api, config, logger, analyst, stt, tts });

const show = (who, text) => console.log(`\n  ${who.padEnd(10)} ${text}`);

console.log(`\n${'='.repeat(78)}\n  SIMULATED CALL - scenario "${which}"`);
console.log(`  on-call model: ${config.anthropic.model}   analysis: ${config.anthropic.analysisModel}\n${'='.repeat(78)}`);

let lastShown = 0;
const flush = () => {
  for (const line of plivo.spoken.slice(lastShown)) show('PRATIBHA', line);
  lastShown = plivo.spoken.length;
};

const started = Date.now();
await call.begin({ streamId: 's1', callUUID: 'sim-1', from: '+919812345678' });
flush();

for (const line of script) {
  if (session.ended) break;
  show('CANDIDATE', line);
  const turnStart = Date.now();
  stt.say(line);
  await call.turnLock;
  flush();
  console.log(`  ${''.padEnd(10)} (turn took ${Date.now() - turnStart} ms)`);
}

await call.finalise(session.outcome);

// finalise fires the analysis without awaiting it, so run it here too and show
// the result - the evidence checks are the part worth seeing.
let assessment = null;
if (session.invite && session.questionsAsked > 0) {
  console.log('\n  running post-call analysis...');
  assessment = await analyst.analyse(session).catch(err => {
    console.error('  analysis failed:', err.message);
    return null;
  });
}

console.log(`\n${'='.repeat(78)}`);
console.log(`  outcome              ${session.outcome}`);
console.log(`  final state          ${session.state}`);
console.log(`  AI disclosure given  ${session.aiDisclosureGiven}`);
console.log(`  recording consent    ${session.recordingConsent ?? '(not reached)'}`);
console.log(`  candidate verified   ${Boolean(session.invite)}`);
console.log(`  questions asked      ${session.questionsAsked}`);
console.log(`  escalation           ${session.escalation ? session.escalation.category : 'none'}`);
console.log(`  wall clock           ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (assessment) {
  console.log(`\n  ASSESSMENT (recommendation: ${assessment.recommendation})`);
  console.log(`  ${assessment.recommendation_reasoning}`);
  for (const score of assessment.scores) {
    const criterion = session.criteria.find(c => c.id === score.criterion_id);
    console.log(`\n   - ${criterion?.criterion}: ${score.score}/5`);
    console.log(`     evidence: "${score.evidence_quote}"`);
  }
  for (const gap of assessment.not_assessed) {
    const criterion = session.criteria.find(c => c.id === gap.criterion_id);
    console.log(`\n   - ${criterion?.criterion}: not scored - ${gap.reason}`);
  }
  console.log(`\n  scores dropped for unverifiable evidence: ${assessment.dropped_scores}`);
}
console.log(`${'='.repeat(78)}\n`);

process.exit(0);
