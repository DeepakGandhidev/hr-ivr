/**
 * Proves the speech half of the stack before any telephony is involved.
 *
 * Uses whichever voice vendor TTS_PROVIDER names, so it is also the fastest way
 * to hear what the line will sound like after switching one.
 *
 * Synthesises a sentence, checks what actually came back is mu-law at 8 kHz,
 * writes it to a WAV you can listen to, then feeds those same bytes into the
 * realtime recogniser and prints the transcript. Both credentials, both codec
 * assumptions and the latency of each leg, in one command.
 *
 *   node scripts/check-speech.js
 *   node scripts/check-speech.js "some other sentence to try"
 *
 * What it does NOT tell you: whether recognition copes with a real candidate on
 * a real line. This feeds a synthetic voice through a clean path. Section 4.1 is
 * explicit that recognition quality has to be measured on recorded calls.
 */
import 'dotenv/config';
import fs from 'fs';
import { loadConfig, ttsProblems } from '../src/config/index.js';
import { createTTS } from '../src/audio/tts.js';
import { SarvamSTT } from '../src/audio/stt.js';
import { mulawToWav } from '../src/utils/wav.js';

const SENTENCE = process.argv[2] ||
  'Hello, thanks for calling ProMonkey Technologies. My reference code is H7K294.';

const config = loadConfig();
const logger = {
  info: () => {}, debug: () => {}, warn: (o, m) => console.log(`   warn: ${m}`),
  error: (o, m) => {
    // The vendor reports failures as a nested object; interpolating it
    // straight into a template gives "[object Object]", which hides the one
    // line that says what is actually wrong (wrong speaker, dead model...).
    const detail = o?.err ?? o?.message ?? o;
    console.log(`   error: ${m} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
};

const fail = (message, hint) => {
  console.log(`\n  FAILED: ${message}`);
  if (hint) console.log(`  ${hint}`);
  console.log('');
  process.exit(1);
};

// The same check the server runs at boot, so a half-configured vendor is named
// here rather than turning into silence on the first synthesised sentence.
const problems = ttsProblems(config.tts);
if (problems.length) fail(problems[0], 'Add it to .env and run this again.');
if (!config.stt.apiKey) fail('SARVAM_API_KEY is not set', 'Recognition is Sarvam whichever voice vendor speaks.');

const el = config.tts.elevenlabs;
const voice = config.tts.provider === 'elevenlabs'
  ? `${el.model} / ${el.voiceId} / ${el.outputFormat}`
  : `${config.tts.model} / ${config.tts.speaker} / ${config.tts.codec}`;

console.log(`\n${'='.repeat(74)}`);
console.log('  SPEECH CHECK');
console.log(`  tts  ${config.tts.provider}: ${voice}`);
console.log(`  stt  ${config.stt.model} / ${config.stt.language} / mulaw 8000`);
console.log(`${'='.repeat(74)}\n`);
console.log(`  saying: "${SENTENCE}"\n`);

// ---- leg 1: text to speech ---------------------------------------------------
const tts = createTTS(config, logger);
const chunks = [];
const ttsStart = Date.now();
let firstChunkMs = null;

try {
  for await (const chunk of tts.stream(SENTENCE)) {
    if (firstChunkMs === null) firstChunkMs = Date.now() - ttsStart;
    chunks.push(chunk);
  }
} catch (err) {
  fail(`TTS failed: ${err.message}`, 'Check SARVAM_API_KEY, and that the speaker name is valid for this model.');
}
tts.close();

if (!chunks.length) {
  fail('TTS returned no audio', `The account may not support output_audio_codec "${config.tts.codec}". Try SARVAM_TTS_CODEC=linear16 with SARVAM_TTS_SOURCE_RATE set to whatever it emits.`);
}

const audio = Buffer.concat(chunks);
const seconds = audio.length / 8000;

console.log(`  TTS   ${audio.length} bytes in ${chunks.length} chunk${chunks.length === 1 ? '' : 's'}`);
console.log(`        first audio after ${firstChunkMs} ms, total ${Date.now() - ttsStart} ms`);
console.log(`        implies ${seconds.toFixed(2)}s of speech at mu-law 8 kHz`);

// mu-law at 8 kHz is exactly 8000 bytes per second. A duration wildly out of
// step with the sentence length means the codec or rate is not what we asked
// for, and everything downstream would be pitch-shifted noise.
const words = SENTENCE.trim().split(/\s+/).length;
const expected = words / 2.5;   // ~150 wpm
if (seconds < expected * 0.4 || seconds > expected * 2.5) {
  console.log(`\n  WARNING: ${seconds.toFixed(2)}s for ${words} words looks wrong (expected roughly ${expected.toFixed(1)}s).`);
  console.log('  The audio is probably not mu-law 8 kHz. Listen to the WAV before going further.');
}

fs.writeFileSync('speech-check.wav', mulawToWav(audio));
console.log(`\n  wrote speech-check.wav - play it. It should sound like clean speech,`);
console.log(`  not chipmunk-fast, slowed down, or like static.`);

// ---- leg 2: speech back to text ----------------------------------------------
console.log(`\n  feeding that audio back into the recogniser...\n`);

const stt = new SarvamSTT(config, logger);
const finals = [];
let firstPartialMs = null;
let sttStart = null;

stt.on('partial', (text) => {
  if (firstPartialMs === null) firstPartialMs = Date.now() - sttStart;
  process.stdout.write(`\r        partial: ${text.slice(0, 60).padEnd(62)}`);
});
stt.on('final', (text) => {
  finals.push(text);
  process.stdout.write(`\r        final:   ${text}\n`);
});

await new Promise((resolve) => {
  // Cleared on connect. Audio below is streamed in real time, so a timer left
  // armed here fires partway through a clip longer than 10s and reports a
  // connection failure for a session that is transcribing perfectly well.
  const timer = setTimeout(
    () => fail('STT did not connect within 10s', 'Check SARVAM_API_KEY and that the realtime endpoint is reachable.'),
    10000
  );
  stt.once('ready', () => { clearTimeout(timer); resolve(); });
  stt.connect();
});

sttStart = Date.now();
// Paced in real time. Dumping the whole buffer at once would not exercise the
// endpointing, which is what decides when a candidate has stopped talking.
for (let offset = 0; offset < audio.length; offset += 160) {
  stt.push(audio.subarray(offset, offset + 160));
  await new Promise(r => setTimeout(r, 20));
}
// The endpointer closes an utterance on silence it *receives*, not on wall
// clock. A real call always has Plivo streaming, so on the wire this happens
// by itself; here the trailing silence has to be sent explicitly or the final
// transcript never arrives and the check reports a failure that is its own.
const silence = Buffer.alloc(160, 0xff);
const silenceFrames = Math.ceil((Number(config.stt.silenceDurationMs) + 1000) / 20);
for (let i = 0; i < silenceFrames; i++) {
  stt.push(silence);
  await new Promise(r => setTimeout(r, 20));
}
await new Promise(r => setTimeout(r, 1500));
stt.close();

console.log(`\n${'='.repeat(74)}`);
if (!finals.length) {
  console.log('  STT returned no transcript.');
  console.log('  If the WAV sounds fine, the recogniser is probably rejecting the encoding.');
  console.log('  Check the "STT session begin" config it echoes back with LOG_LEVEL=info.');
} else {
  console.log(`  heard back: "${finals.join(' ')}"`);
  console.log(`  first partial after ${firstPartialMs} ms`);
  console.log(`\n  Both legs work. Numbers to keep in mind for the 800 ms budget (4.2):`);
  console.log(`    TTS first audio    ${firstChunkMs} ms`);
  console.log(`    STT first partial  ${firstPartialMs} ms`);
  console.log(`\n  Measured from here, not from India. Re-measure on the ap-south-1 host.`);
}
console.log(`${'='.repeat(74)}\n`);
process.exit(finals.length ? 0 : 1);
