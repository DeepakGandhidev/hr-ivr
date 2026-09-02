import 'dotenv/config';
import { describeHours } from '../lib/plivoXml.js';
import { TTS_PROVIDERS, elevenLabsSourceRate } from '../audio/tts.js';

const int = (value, fallback) => (value === undefined ? fallback : parseInt(value, 10));

export function loadConfig() {
  return {
    port: int(process.env.PORT, 8091),
    publicWsUrl: process.env.PUBLIC_WS_URL || 'wss://hiring.promonkey.tech/pratibha/stream',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://hiring.promonkey.tech',
    mockMode: process.env.MOCK_MODE === 'true',

    plivo: {
      // Used only to verify that an inbound webhook really came from Plivo.
      // There is deliberately no auth id / token pair here for the REST API:
      // 3.1 forbids outbound calling, and the surest way to keep that true is
      // for this service to hold no credential capable of placing a call.
      authToken: process.env.PLIVO_AUTH_TOKEN,
      number: process.env.PRATIBHA_NUMBER || '+918031705255',
      verifySignature: process.env.PLIVO_VERIFY_SIGNATURE !== 'false'
    },

    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      // On the call: fast matters more than clever - the model is picking the
      // next question, not writing the assessment.
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
      // After the call: no latency budget, and the scoring is what a human acts
      // on, so this one is worth the extra capability.
      analysisModel: process.env.ANTHROPIC_ANALYSIS_MODEL || 'claude-opus-5'
    },

    stt: {
      endpoint: process.env.SARVAM_STT_ENDPOINT,
      apiKey: process.env.SARVAM_API_KEY,
      model: process.env.SARVAM_STT_MODEL || 'saaras:v3-realtime',
      // `auto` lets a candidate slip into Hindi mid-answer without the
      // transcript falling apart, which on Indian hiring calls is normal rather
      // than exceptional. Set to en-IN with mode=codemix if auto proves noisy.
      language: process.env.SARVAM_STT_LANGUAGE || 'auto',
      mode: process.env.SARVAM_STT_MODE || 'transcribe',
      streamType: process.env.SARVAM_STT_STREAM_TYPE || 'fast',
      threshold: process.env.SARVAM_STT_THRESHOLD || '0.3',
      // Interview answers contain long thinking pauses. Sarvam's 500 ms default
      // cuts a candidate off mid-thought; 800 ms costs a little latency at the
      // end of each turn and stops Pratibha talking over someone who was still
      // gathering their point.
      silenceDurationMs: int(process.env.SARVAM_STT_SILENCE_MS, 800),
      minSpeechDurationMs: int(process.env.SARVAM_STT_MIN_SPEECH_MS, 250)
    },

    tts: {
      // Which vendor speaks. Sarvam is the default: its voices are Indian
      // English by default and it emits mu-law 8 kHz straight out, so nothing
      // is transcoded on the way to Plivo. Switch with TTS_PROVIDER=elevenlabs.
      provider: (process.env.TTS_PROVIDER || 'sarvam').toLowerCase(),

      endpoint: process.env.SARVAM_TTS_ENDPOINT,
      apiKey: process.env.SARVAM_API_KEY,
      model: process.env.SARVAM_TTS_MODEL || 'bulbul:v3',
      speaker: process.env.SARVAM_TTS_SPEAKER || 'ritu',
      language: process.env.SARVAM_TTS_LANGUAGE || 'en-IN',
      pace: Number(process.env.SARVAM_TTS_PACE || 1.0),
      // mu-law straight out means no transcode before Plivo. If the account
      // cannot emit it, set linear16 and the resampler in tts.js takes over.
      codec: process.env.SARVAM_TTS_CODEC || 'mulaw',
      sourceRate: int(process.env.SARVAM_TTS_SOURCE_RATE, 8000),

      // Read only when provider is `elevenlabs`. There is no default voice on
      // purpose - a wrong voice id is a wrong-sounding interviewer on a live
      // call, so it has to be a deliberate choice.
      elevenlabs: {
        endpoint: process.env.ELEVENLABS_TTS_ENDPOINT,
        apiKey: process.env.ELEVENLABS_API_KEY,
        // Flash is the low-latency model. Turbo trades a little latency for
        // better prosody; anything slower is not usable on a live call.
        model: process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5',
        voiceId: process.env.ELEVENLABS_VOICE_ID,
        // ulaw_8000 needs no transcode before Plivo. pcm_16000 and friends work
        // too - the sample rate is read back off this string, so the two cannot
        // drift apart.
        outputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || 'ulaw_8000',
        stability: Number(process.env.ELEVENLABS_STABILITY || 0.5),
        similarityBoost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.75),
        speed: Number(process.env.ELEVENLABS_SPEED || 1.0)
      }
    },

    vad: {
      ratio: Number(process.env.VAD_RATIO || 3.0),
      floor: Number(process.env.VAD_FLOOR || 0.010),
      speechFrames: int(process.env.VAD_SPEECH_FRAMES, 3),
      silenceFrames: int(process.env.VAD_SILENCE_FRAMES, 25)
    },

    os: {
      apiBase: process.env.OS_API_BASE || 'https://os.promonkey.tech',
      serviceToken: process.env.OS_SERVICE_TOKEN,
      hmacSecret: process.env.OS_HMAC_SECRET,
      timeoutMs: int(process.env.OS_TIMEOUT_MS, 8000)
    },

    // 4.3 - proposed default, pending the product owner's confirmation.
    operatingHours: (() => {
      const hours = {
        timezone: process.env.OPERATING_TIMEZONE || 'Asia/Kolkata',
        // 1 = Monday ... 5 = Friday. Saturday (6) and Sunday (0) are closed.
        days: (process.env.OPERATING_DAYS || '1,2,3,4,5').split(',').map(Number),
        // 0 to 24 is the whole day, so the line is open around the clock on
        // every configured day.
        startHour: int(process.env.OPERATING_START_HOUR, 0),
        endHour: int(process.env.OPERATING_END_HOUR, 24)
      };
      // Derived, so the hours enforced and the hours read out to callers cannot
      // drift apart. Override only when the wording itself needs to change.
      hours.label = process.env.OPERATING_HOURS_LABEL || describeHours(hours);
      return hours;
    })(),

    // 4.4 - start conservative and watch it. Every concurrent call holds an
    // STT socket, a TTS socket and a model session.
    maxConcurrentCalls: int(process.env.MAX_CONCURRENT_CALLS, 10),

    logging: { level: process.env.LOG_LEVEL || 'info' }
  };
}

/**
 * Check the credentials at boot rather than discovering they are missing when
 * the first candidate calls in. A screening line that answers and then fails is
 * worse than one that never started: the candidate has used their one attempt.
 *
 * Returns a list of problems; the caller decides whether to refuse to start.
 */
/**
 * Whichever vendor TTS_PROVIDER names has to be fully configured. Checked here
 * rather than in the provider, because a synthesis vendor that is only half set
 * up fails on the first thing Pratibha tries to say - after the candidate has
 * already been answered and greeted with silence.
 *
 * Exported so scripts/check-speech.js runs the identical check.
 */
export function ttsProblems(tts) {
  const problems = [];

  if (!(tts.provider in TTS_PROVIDERS)) {
    return [`TTS_PROVIDER is "${tts.provider}" - expected one of ${Object.keys(TTS_PROVIDERS).join(', ')}.`];
  }

  if (tts.provider === 'sarvam' && !tts.apiKey) {
    problems.push('SARVAM_API_KEY is not set but TTS_PROVIDER=sarvam - Pratibha would have no voice.');
  }

  if (tts.provider === 'elevenlabs') {
    const { apiKey, voiceId, outputFormat } = tts.elevenlabs;
    if (!apiKey) problems.push('ELEVENLABS_API_KEY is not set but TTS_PROVIDER=elevenlabs - Pratibha would have no voice.');
    if (!voiceId) problems.push('ELEVENLABS_VOICE_ID is not set but TTS_PROVIDER=elevenlabs - there is no default voice.');
    if (Number.isNaN(elevenLabsSourceRate(outputFormat))) {
      // The mp3 formats would connect and stream happily, and Plivo would play
      // the bytes as if they were mu-law: loud static into the caller's ear.
      problems.push(`ELEVENLABS_OUTPUT_FORMAT is "${outputFormat}" - only ulaw_8000 and pcm_<rate> can be sent to Plivo.`);
    }
  }

  return problems;
}

export function validateConfig(config) {
  const problems = [];

  if (!config.anthropic.apiKey) problems.push('ANTHROPIC_API_KEY is not set - Pratibha cannot decide what to say.');
  if (!config.stt.apiKey) problems.push('SARVAM_API_KEY is not set - no speech recognition.');

  problems.push(...ttsProblems(config.tts));

  if (!config.mockMode) {
    if (!config.os.apiBase) problems.push('OS_API_BASE is not set - no way to look up invites.');
    if (!config.os.serviceToken) problems.push('OS_SERVICE_TOKEN is not set - ProMonkey OS will reject every request.');
    if (!config.os.hmacSecret) problems.push('OS_HMAC_SECRET is not set - writes back to ProMonkey OS will not be signed.');
  }

  if (config.plivo.verifySignature && !config.plivo.authToken) {
    // Verification fails closed, so this would refuse every real call with a
    // 403 and the line would appear dead.
    problems.push('PLIVO_AUTH_TOKEN is not set but signature verification is on - every call would be rejected. Set the token, or PLIVO_VERIFY_SIGNATURE=false for local testing only.');
  }

  if (!config.publicWsUrl.startsWith('wss://') && !config.publicWsUrl.startsWith('ws://localhost')) {
    problems.push(`PUBLIC_WS_URL is "${config.publicWsUrl}" - Plivo requires wss:// for a real number.`);
  }

  return problems;
}
