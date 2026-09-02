import fs from 'fs';
import path from 'path';

/**
 * One transcript per call: every caller turn, everything Pratibha said, every
 * tool call and result, every state change, with elapsed timestamps - so a
 * stall shows up as the gap after the last line.
 *
 * The durable copy lives in ProMonkey OS, which encrypts it, restricts it to
 * Admin and logs every access (3.6). Writing a second copy to the application
 * server's disk would put candidate personal data outside all three of those
 * controls, so local files are off unless someone deliberately turns them on to
 * debug, and the directory is expected to be short-lived when they do.
 */
export class CallTranscript {
  constructor(sessionId, callUUID, logger, options = {}) {
    this.sessionId = sessionId;
    this.callUUID = callUUID;
    this.logger = logger;
    this.startedAt = Date.now();
    this.entries = [];

    this.dir = options.dir ?? process.env.TRANSCRIPT_DIR ?? null;
    this.writable = false;

    if (this.dir) {
      const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-');
      this.basePath = path.join(this.dir, `${stamp}_${callUUID || sessionId}`);
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        this.writable = true;
      } catch (err) {
        this.logger.warn({ sessionId, err: err.message }, 'Transcript directory unavailable, logging only');
      }
    }
  }

  elapsed() { return Date.now() - this.startedAt; }

  static formatElapsed(ms) {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  }

  record(kind, detail = {}) {
    const entry = { at: new Date().toISOString(), elapsedMs: this.elapsed(), kind, ...detail };
    this.entries.push(entry);
    this.logger.info({ sessionId: this.sessionId, callUUID: this.callUUID, ...entry }, `transcript:${kind}`);
    this.append(CallTranscript.line(entry));
    return entry;
  }

  static line(entry) {
    const LABELS = {
      'call.start': 'CALL START',
      'call.end': 'CALL END',
      caller: 'CANDIDATE',
      pratibha: 'PRATIBHA',
      'caller.interim': 'partial',
      disclosure: 'AI DISCLOSED',
      interrupt: 'BARGE-IN',
      dtmf: 'DTMF',
      'tts.first_audio': 'first audio',
      'model.request': 'MODEL ->',
      'model.response': 'MODEL <-',
      'model.silent': '*** DEAD AIR',
      'model.error': '*** MODEL ERROR',
      'tool.call': 'TOOL CALL',
      'tool.result': 'TOOL OK',
      'tool.error': '*** TOOL FAILED',
      state: 'STATE',
      escalate: 'ESCALATED',
      technical_failure: '*** TECHNICAL FAILURE'
    };

    const { kind, elapsedMs, at, ...rest } = entry;
    const detail = Object.entries(rest)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');

    return `[${CallTranscript.formatElapsed(elapsedMs)}] ${(LABELS[kind] || kind).padEnd(16)} ${detail}`;
  }

  append(line) {
    if (!this.writable) return;
    try {
      fs.appendFileSync(`${this.basePath}.log`, `${line}\n`);
    } catch (err) {
      this.writable = false;
      this.logger.warn({ sessionId: this.sessionId, err: err.message }, 'Transcript write failed, logging only');
    }
  }

  /** Called once the call is over. Returns the entries for the OS API. */
  end(session) {
    const last = this.entries[this.entries.length - 1];

    this.record('call.end', {
      outcome: session?.outcome,
      finalState: session?.state,
      durationMs: this.elapsed(),
      turns: this.entries.filter(e => e.kind === 'caller').length,
      questionsAsked: session?.questionsAsked,
      aiDisclosureGiven: session?.aiDisclosureGiven,
      recordingConsent: session?.recordingConsent,
      candidate: session?.candidate?.id,
      job: session?.job?.id
    });

    // 10 - assert it rather than trust it. A completed screening that cannot
    // prove the candidate heard the disclosure is a compliance defect, and it
    // needs to be loud in the logs the moment it happens.
    if (session?.outcome === 'completed' && !session?.aiDisclosureGiven) {
      this.logger.error({
        sessionId: this.sessionId, callUUID: this.callUUID
      }, 'COMPLIANCE: call completed without a confirmed AI disclosure');
    }

    if (!session?.ended || session?.outcome === 'abandoned') {
      const stalledFor = last ? this.elapsed() - last.elapsedMs : 0;
      this.append(
        `\nCall ended in state ${session?.state} without completing. Last activity was ` +
        `${CallTranscript.formatElapsed(last?.elapsedMs ?? 0)} (${Math.round(stalledFor / 1000)}s of silence before hangup):\n` +
        `  ${last ? CallTranscript.line(last) : 'nothing recorded'}\n`
      );
      this.logger.warn({
        sessionId: this.sessionId, finalState: session?.state,
        lastActivity: last?.kind, silentForMs: stalledFor
      }, 'Call ended without completing - see transcript');
    }

    if (this.writable) {
      try {
        fs.writeFileSync(`${this.basePath}.json`, JSON.stringify({
          sessionId: this.sessionId,
          callUUID: this.callUUID,
          startedAt: new Date(this.startedAt).toISOString(),
          outcome: session?.outcome,
          entries: this.entries
        }, null, 2));
      } catch (err) {
        this.logger.warn({ sessionId: this.sessionId, err: err.message }, 'Transcript JSON write failed');
      }
    }

    return this.entries;
  }
}
