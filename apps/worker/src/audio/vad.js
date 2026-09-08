import { frameEnergy } from './mulaw.js';

// Energy VAD, used for one job only: deciding fast enough that the candidate
// has started talking over Pratibha so we can send clearAudio.
//
// Turn-taking - "has the candidate finished their answer" - is Sarvam's job,
// not this one. Sarvam's endpointing sees the actual words and is far better at
// it, but its verdict arrives a network round trip late. Barge-in cannot wait
// that long: the candidate hears Pratibha keep talking over them and the call
// feels broken. So the cheap local detector handles interruption and the remote
// one handles turns.
//
// A fixed threshold does not survive contact with Indian mobile networks - line
// noise varies enormously between a fibre desk phone and a 2-bar 4G call. The
// floor adapts to whatever this particular line sounds like when nobody is
// speaking.
export class VoiceActivityDetector {
  constructor(options = {}) {
    // Speech must clear the measured noise floor by this factor. Set from
    // listening to real calls: 3x separates speech from hiss without losing a
    // softly-spoken candidate.
    this.ratio = options.ratio ?? 3.0;
    // Absolute floor, so a dead-silent line cannot drive the noise floor to
    // zero and make every faint click read as speech.
    this.floor = options.floor ?? 0.010;
    // 3 frames = 60 ms. Shorter fires on lip smacks and network pops; longer
    // and the candidate has said most of a word before Pratibha stops.
    this.speechFrames = options.speechFrames ?? 3;
    // 25 frames = 500 ms. Natural pauses mid-sentence are shorter than this.
    this.silenceFrames = options.silenceFrames ?? 25;
    this.adaptRate = options.adaptRate ?? 0.05;

    this.noiseFloor = this.floor;
    this.speaking = false;
    this.aboveCount = 0;
    this.belowCount = 0;
    this.framesSeen = 0;
  }

  get threshold() {
    return Math.max(this.noiseFloor * this.ratio, this.floor);
  }

  /**
   * Feed one 20 ms mu-law frame.
   * Returns 'speech-start', 'speech-end', or null when nothing changed.
   */
  push(frame) {
    const energy = frameEnergy(frame);
    this.framesSeen++;

    const loud = energy > this.threshold;

    // Only learn the floor from frames that are not speech, or the floor
    // climbs to meet a talkative caller and the detector goes deaf.
    if (!loud && !this.speaking) {
      this.noiseFloor += (energy - this.noiseFloor) * this.adaptRate;
    }

    if (loud) {
      this.aboveCount++;
      this.belowCount = 0;
    } else {
      this.belowCount++;
      this.aboveCount = 0;
    }

    if (!this.speaking && this.aboveCount >= this.speechFrames) {
      this.speaking = true;
      return 'speech-start';
    }
    if (this.speaking && this.belowCount >= this.silenceFrames) {
      this.speaking = false;
      return 'speech-end';
    }
    return null;
  }

  /**
   * Called when Pratibha starts speaking. The detector keeps its learned noise
   * floor - that is a property of the line, not the turn - but forgets any
   * partial run, so audio from the previous turn cannot trip a barge-in.
   */
  reset() {
    this.speaking = false;
    this.aboveCount = 0;
    this.belowCount = 0;
  }
}
