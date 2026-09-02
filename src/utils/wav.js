import { decode } from '../audio/mulaw.js';
import { pcmToMulaw8k } from '../audio/tts.js';

/**
 * WAV helpers for the test harnesses only - nothing on the call path writes or
 * reads audio files. They exist so a developer can listen to what Pratibha
 * actually said, and feed a real recorded voice back in.
 */

/** Wrap mu-law 8 kHz as 16-bit PCM WAV, playable anywhere. */
export function mulawToWav(mulaw) {
  const samples = decode(mulaw);
  const dataBytes = samples.length * 2;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // format: PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(8000, 24);        // sample rate
  header.writeUInt32LE(16000, 28);       // byte rate
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  const body = Buffer.alloc(dataBytes);
  for (let i = 0; i < samples.length; i++) body.writeInt16LE(samples[i], i * 2);
  return Buffer.concat([header, body]);
}

/** Read a 16-bit PCM WAV back to mu-law 8 kHz, downmixing and resampling. */
export function wavToMulaw(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }

  let channels = 1;
  let sampleRate = 8000;
  let bits = 16;
  let pcm = null;

  // Walk the chunks. The data chunk is not reliably at offset 44 - most
  // recorders write a LIST or fact chunk ahead of it.
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bits = buffer.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      pcm = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length));
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (!pcm) throw new Error('no data chunk in WAV');
  if (bits !== 16) throw new Error(`need 16-bit PCM, got ${bits}-bit - convert with: ffmpeg -i in.wav -acodec pcm_s16le -ac 1 -ar 8000 out.wav`);

  if (channels > 1) {
    const frames = Math.floor(pcm.length / 2 / channels);
    const mono = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((i * channels + c) * 2);
      mono.writeInt16LE(Math.round(sum / channels), i * 2);
    }
    pcm = mono;
  }

  return pcmToMulaw8k(pcm, sampleRate);
}
