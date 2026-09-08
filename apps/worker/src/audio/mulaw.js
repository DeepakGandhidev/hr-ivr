// G.711 mu-law. Plivo streams mu-law 8 kHz in both directions, and Sarvam's
// realtime STT accepts mu-law 8 kHz directly, so the caller's audio never needs
// decoding on the way in. This module exists for the two places that do need
// linear samples: the barge-in VAD, which measures energy, and any TTS voice
// that can only emit linear PCM.

const BIAS = 0x84;
const CLIP = 32635;

// 256-entry table beats recomputing the shifts for every one of the 8000
// samples that arrive each second.
const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + BIAS;
  t <<= (u & 0x70) >> 4;
  DECODE[i] = (u & 0x80) ? (BIAS - t) : (t - BIAS);
}

const EXPONENT = [
  0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7
];

// 0xFF is digital silence: it decodes to exactly 0.
export const SILENCE_BYTE = 0xff;

export function decodeByte(byte) {
  return DECODE[byte & 0xff];
}

export function encodeSample(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  let mag = sample < 0 ? -sample : sample;
  if (mag > CLIP) mag = CLIP;
  mag += BIAS;
  const exponent = EXPONENT[(mag >> 7) & 0xff];
  const mantissa = (mag >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** mu-law bytes -> Int16 linear samples. */
export function decode(buffer) {
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) out[i] = DECODE[buffer[i]];
  return out;
}

/** Int16 linear samples -> mu-law bytes. */
export function encode(samples) {
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = encodeSample(samples[i]);
  return out;
}

/**
 * RMS of a mu-law frame, normalised to 0..1. Decoding through the table and
 * squaring is cheap enough at 8 kHz that measuring the mu-law byte distance
 * directly - which is logarithmic and would skew the noise floor - is not
 * worth the accuracy it costs the VAD.
 */
export function frameEnergy(buffer) {
  if (buffer.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const s = DECODE[buffer[i]];
    sum += s * s;
  }
  return Math.sqrt(sum / buffer.length) / 32768;
}

export const SAMPLE_RATE = 8000;
export const FRAME_SAMPLES = 160;      // 20 ms at 8 kHz
export const BYTES_PER_MS = SAMPLE_RATE / 1000;
