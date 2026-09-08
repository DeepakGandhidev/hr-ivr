/**
 * Places a call at the running agent while pretending to be Plivo.
 *
 * Speaks the Plivo audio-streaming protocol exactly - start, media, checkpoint,
 * playedStream, clearAudio - against a locally running server. Everything is
 * real except the carrier: real WebSocket framing, real mu-law, real Sarvam
 * recognition and synthesis, real model turns, real state machine.
 *
 * Candidate turns are synthesised from text by default, so no recordings are
 * needed. Pass real ones once you have them - a recorded human on a real line
 * is the only thing that measures recognition honestly (4.1).
 *
 *   npm start                                  # in another terminal
 *   node scripts/fake-call.js
 *   node scripts/fake-call.js --wav a.wav,b.wav,c.wav
 *   node scripts/fake-call.js --port 8091 --scenario badcode
 *
 * Writes pratibha.wav - what the candidate would have heard.
 */
import 'dotenv/config';
import fs from 'fs';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config/index.js';
import { SarvamTTS } from '../src/audio/tts.js';
import { mulawToWav, wavToMulaw } from '../src/utils/wav.js';
import { SILENCE_BYTE } from '../src/audio/mulaw.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const SCENARIOS = {
  normal: [
    'Hi, yes, my code is H 7 K 2 9 4.',
    'Yes, now is a good time.',
    "That's fine, you can record it.",
    'At Infosys I rebuilt the settlement service in Node, and we cut reconciliation time from six hours to twenty minutes.',
    'There were four of us on that team, and I ran the code reviews and onboarded two juniors.',
    'We used REST with an idempotency key on every write, because the payment gateway retried and we were double charging people.',
    "No, I haven't used AWS much. We were on premise for most of it.",
    'No questions from me, thank you.',
    'No, nothing else. Thanks for your time.'
  ],
  badcode: ['My code is Z Z Z Z Z Z.', 'Let me try again, Z Z Z 9 9 9.'],
  human: ['My code is H 7 K 2 9 4.', 'Could I speak to a real person instead?'],
  busy: ['My code is H 7 K 2 9 4.', "Sorry, I'm driving right now. Can I call back later?"]
};

const port = arg('port', process.env.PORT || '8091');
const scenario = arg('scenario', 'normal');
const wavList = arg('wav');
const config = loadConfig();
const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: (o, m) => console.log(`  ! ${m}`) };

// ---- prepare the candidate's turns -------------------------------------------
let turns = [];
if (wavList) {
  turns = wavList.split(',').map((path) => ({
    label: path.trim(),
    audio: wavToMulaw(fs.readFileSync(path.trim()))
  }));
} else {
  const lines = SCENARIOS[scenario];
  if (!lines) {
    console.error(`unknown scenario "${scenario}". one of: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  if (!config.tts.apiKey) {
    console.error('SARVAM_API_KEY is not set - needed to synthesise the candidate. Or pass --wav.');
    process.exit(1);
  }
  console.log(`\n  synthesising ${lines.length} candidate turns...`);
  // A different voice from Pratibha's, so a recording of the call is legible.
  const voice = new SarvamTTS(
    { ...config, tts: { ...config.tts, speaker: process.env.CANDIDATE_SPEAKER || 'amit' } },
    logger
  );
  for (const line of lines) {
    const chunks = [];
    for await (const chunk of voice.stream(line)) chunks.push(chunk);
    if (!chunks.length) { console.error(`  failed to synthesise: "${line}"`); process.exit(1); }
    turns.push({ label: line, audio: Buffer.concat(chunks) });
  }
  voice.close();
}

// ---- connect as Plivo would ---------------------------------------------------
const callUUID = `fake-${Date.now()}`;
const url = `ws://localhost:${port}/pratibha/stream?callUUID=${callUUID}`;
console.log(`  connecting to ${url}\n${'='.repeat(74)}\n`);

const ws = new WebSocket(url);
const heard = [];            // everything Pratibha played, for the WAV
let queuedMs = 0;            // audio we have been sent but not yet "played"
let lastAudioAt = Date.now();
let turnIndex = 0;
let sending = false;
let finished = false;

const send = (payload) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(payload));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

ws.on('open', () => {
  send({
    event: 'start',
    start: {
      streamId: 'fake-stream',
      callId: callUUID,
      callUUID,
      from: '+919812345678',
      mediaFormat: { contentType: 'audio/x-mulaw', sampleRate: 8000 }
    }
  });
  pump();
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());

  if (message.event === 'playAudio') {
    const audio = Buffer.from(message.media.payload, 'base64');
    heard.push(audio);
    queuedMs += audio.length / 8;
    lastAudioAt = Date.now();
  } else if (message.event === 'checkpoint') {
    // Plivo acks a checkpoint once playback passes it. Honouring the real
    // timing matters: acking instantly would make the agent think the candidate
    // heard a sentence that is still queued, and the barge-in bookkeeping
    // depends on this being truthful.
    const id = message.checkpoint.id;
    const waitMs = queuedMs;
    queuedMs = 0;
    setTimeout(() => send({ event: 'playedStream', playedStream: { checkpointId: id } }), waitMs);
  } else if (message.event === 'clearAudio') {
    queuedMs = 0;
    send({ event: 'clearedAudio', clearedAudio: {} });
    console.log('  [barge-in: agent cleared its queue]');
  }
});

ws.on('close', () => finish('socket closed by the agent'));
ws.on('error', (err) => {
  console.error(`\n  connection failed: ${err.message}`);
  console.error(`  Is the agent running? Try:  MOCK_MODE=true npm start\n`);
  process.exit(1);
});

/**
 * The caller's side of the line: always sending, 20 ms at a time. Silence when
 * the candidate is not talking, because the recogniser's endpointing needs to
 * hear that silence to decide a turn is over.
 */
async function pump() {
  const silence = Buffer.alloc(160, SILENCE_BYTE);

  while (!finished && ws.readyState === WebSocket.OPEN) {
    if (!sending && turnIndex < turns.length && ready()) {
      sending = true;
      const turn = turns[turnIndex++];
      console.log(`  CANDIDATE  ${turn.label}`);
      for (let o = 0; o < turn.audio.length && !finished; o += 160) {
        send({ event: 'media', media: { payload: turn.audio.subarray(o, o + 160).toString('base64') } });
        await sleep(20);
      }
      sending = false;
      lastAudioAt = Date.now();
    } else {
      send({ event: 'media', media: { payload: silence.toString('base64') } });
      await sleep(20);
    }

    // Nothing from either side for a while means the call is over.
    if (turnIndex >= turns.length && Date.now() - lastAudioAt > 12000) {
      finish('nothing further from either side');
    }
  }
}

/** Only speak once Pratibha has stopped and left a natural gap. */
function ready() {
  return queuedMs === 0 && Date.now() - lastAudioAt > 900;
}

function finish(why) {
  if (finished) return;
  finished = true;

  const audio = Buffer.concat(heard);
  if (audio.length) {
    fs.writeFileSync('pratibha.wav', mulawToWav(audio));
  }

  console.log(`\n${'='.repeat(74)}`);
  console.log(`  call ended - ${why}`);
  console.log(`  candidate turns delivered  ${turnIndex} of ${turns.length}`);
  console.log(`  Pratibha audio             ${(audio.length / 8000).toFixed(1)}s -> pratibha.wav`);
  console.log(`\n  Play pratibha.wav to hear the call. The agent's own log has the`);
  console.log(`  transcript, the state transitions and the outcome.`);
  console.log(`${'='.repeat(74)}\n`);

  try { ws.close(); } catch {}
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', () => finish('interrupted'));
