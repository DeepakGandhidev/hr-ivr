# Pratibha — inbound hiring agent

Answers `+91 80 3170 5255`, verifies a shortlisted candidate's reference code, runs a
first-round screening against the job's rubric, and files a transcript, per-criterion
scores and a recommendation into ProMonkey OS for a human to act on.

Phase 3 of the Jobs module spec. Forked from Scout, the DollarTraq inbound agent —
same architecture, different domain, **different telephony**.

## The one thing to understand first

Scout runs on **Twilio ConversationRelay**, which is a managed voice layer: Twilio does
speech-to-text, text-to-speech, endpointing and barge-in, and the app only ever exchanges
*text* over the socket.

**Plivo has no equivalent.** `<Stream bidirectional="true">` gives you raw μ-law 8 kHz
frames in both directions and nothing else — the analogue of Twilio Media Streams, one
rung below ConversationRelay. Everything ConversationRelay used to do is now ours:

| Twilio gave us | Here |
|---|---|
| `prompt` events with `last: true` | [audio/stt.js](src/audio/stt.js) — Sarvam realtime, which also does endpointing |
| `{type:'text', token}` → speech | [audio/tts.js](src/audio/tts.js) — Sarvam or ElevenLabs streaming, μ-law out |
| `interrupt` + `utteranceUntilInterrupt` | [audio/vad.js](src/audio/vad.js) + checkpoint tracking in [audio/plivoStream.js](src/audio/plivoStream.js) |
| Turn-taking, playback queue | [lib/callSession.js](src/lib/callSession.js) |

Two facts made this much smaller than it looks. Sarvam's realtime STT accepts **μ-law
8 kHz directly**, so Plivo's frames pass through with no transcoding at all; and its
`endpointing=vad` handles turn detection, which needs the words and not just the
waveform. The local VAD is only for barge-in, where 60 ms matters more than accuracy.

## Architecture

```
Plivo  ──inbound only──▶  /pratibha/answer      hours · concurrency · signature
                                  │
                                  ▼  <Stream bidirectional audioTrack="inbound">
                          /pratibha/stream  (WebSocket, μ-law 8 kHz)
                                  │
                    ┌─────────────┴─────────────┐
              caller audio                 playAudio / clearAudio
                    │                             ▲
        ┌───────────┴───────────┐                 │
        ▼                       ▼                 │
   VAD (barge-in)        Sarvam STT               │
        │                       │                 │
        └──▶ clearAudio         ▼                 │
                          utterance               │
                                │                 │
                                ▼                 │
                        ScreeningAgent  ──▶  TTS (Sarvam / ElevenLabs)
                        (Claude + tools)
                                │
                                ▼
                        ProMonkey OS API
```

`audioTrack="inbound"` is load-bearing: it keeps Pratibha's own voice off the stream, so
she neither transcribes herself nor trips her own barge-in detector.

## Call flow

```
GREET ──▶ VERIFY_CODE ──▶ CONSENT_TIME ──▶ CONSENT_RECORDING ──▶ SCREEN ──▶ CANDIDATE_QA ──▶ CLOSE
             │                  │                                   │
             │                  └─▶ call_back_later                 └─▶ escalated
             └─▶ wrong_code                                             (asked for a human,
                 (logged to CallLogUnmatched)                            hostile, bad line)
```

The transitions in [lib/states.js](src/lib/states.js) are the enforcement, not the prompt.
There is no path into `SCREEN` that skips verification or consent, and the model is only
ever offered the tools valid for its current state.

## The non-negotiables, and where each one lives

Section numbers are from the spec. Each is a test in
[tests/guardrails.test.js](tests/guardrails.test.js).

| § | Rule | Enforced by |
|---|---|---|
| 3.1 | Never places an outbound call | No telephony SDK, no auth id (Plivo REST needs one), no callback tool. A test greps the source. |
| 3.2 | Discloses she is an AI | Fixed string, spoken before the model gets control. `ai_disclosure_given` is set **only when Plivo confirms playback** — it means the candidate heard it, not that we tried. |
| 3.3 | Consent before recording | Recording starts only after `record_recording_consent(granted: true)`. Declining continues the call. |
| 3.4 | Cannot reject | Recommendation is `pursue \| hold \| do_not_pursue`; anything else is coerced to `hold`. Status filed is always `recommended`. |
| 3.5 | Scores cite evidence | Every quote is checked against the transcript. A score whose quote isn't there is **dropped** and reported as not-assessed. |
| 3.6 | Candidate data is sensitive | Durable copy in ProMonkey OS. Local transcripts off unless `TRANSCRIPT_DIR` is set. |
| 3.7 | Reference code gates the line | Two attempts, then the call ends. `end_call('completed')` on an unverified caller is downgraded to `wrong_code`. |
| 4.3 | Out of hours gets a message | Decided in the answer URL, before any audio. The spoken hours are derived from the enforced hours so they cannot drift. |
| 4.4 | Concurrency | `MAX_CONCURRENT_CALLS`, then a busy message rather than a dead line. |

## Running it

```bash
npm install
cp .env.example .env      # fill in PLIVO_AUTH_TOKEN, ANTHROPIC_API_KEY, SARVAM_API_KEY, OS_*
npm test                  # 63 tests, no network
npm run simulate          # a whole call, no telephony and no speech vendors
npm start
```

`npm run simulate` drives a scripted candidate through the real state machine, tools,
model turns and post-call analysis using mock speech services:

```bash
npm run simulate            # normal screening
npm run simulate badcode    # caller cannot give a valid code
npm run simulate human      # caller asks for a person
npm run simulate busy       # caller cannot talk now
```

It exercises everything except the two vendor sockets. It cannot tell you whether
recognition copes with a real candidate on a real line — §4.1 is explicit that has to be
measured on recorded calls.

## Before go-live

1. **Verify the webhook signature reconstruction.** Validation fails closed, so if it's
   wrong every call is refused with a 403 and the line looks dead. Capture one real
   webhook with `PLIVO_VERIFY_SIGNATURE=false`, then
   `npm run check:signature captured.json`.
2. **Confirm Sarvam emits μ-law at 8 kHz** on your account. If not, set
   `SARVAM_TTS_CODEC=linear16` and the resampler takes over. To use ElevenLabs
   instead, set `TTS_PROVIDER=elevenlabs` with `ELEVENLABS_API_KEY` and
   `ELEVENLABS_VOICE_ID`; `npm run check:speech` synthesises through whichever
   vendor is selected, so you can hear both before choosing. Recognition stays
   on Sarvam either way.
3. **Tune the VAD on real calls.** Too sensitive and line noise cuts Pratibha off
   mid-question; too dull and she talks over the candidate.
4. **Measure the latency budget** (§4.2, under 800 ms). You now own the whole chain, so
   host in `ap-south-1` and keep speech in-country — which §3.6 wants anyway.

## Plivo account notes

Indian numbers need the Plivo organisation to be in the **India data region**, which
cannot be migrated from a US org. `080` landline numbers are non-BFSI, **service and
transactional calls only** — which inbound-only screening is; promotional calling needs
a 140-series number and is out of scope by §3.1 anyway.

## Layout

```
src/
├── index.js                  entry point, WebSocket upgrade
├── config/index.js
├── routes/index.js           answer URL: hours, concurrency, signature
├── audio/
│   ├── plivoStream.js        Plivo protocol + checkpoint bookkeeping
│   ├── mulaw.js              G.711 codec and frame energy
│   ├── vad.js                barge-in detection
│   ├── stt.js                Sarvam realtime
│   ├── tts.js                Sarvam or ElevenLabs streaming (TTS_PROVIDER)
│   └── mockSpeech.js         offline stand-ins
├── lib/
│   ├── callSession.js        the real-time loop
│   ├── states.js             state machine and tool gating
│   ├── screening.js          model turns, tool chaining, history window
│   ├── toolExecutor.js       the tools, and the verbatim compliance lines
│   ├── analysis.js           post-call scoring with evidence verification
│   ├── history.js            barge-in reconciliation
│   ├── osApi.js              ProMonkey OS client
│   ├── plivoXml.js           answer documents
│   ├── transcript.js
│   └── sampling.js           models that reject temperature
└── utils/
    ├── plivoSignature.js     webhook V3 validation
    ├── speech.js             markdown stripping, sentence splitting
    ├── hmac.js
    └── shutdown.js           drains live calls before exit
```

## Still open

- Reference codes are alphanumeric, so they cannot be keyed in. DTMF entry is wired up
  and would be far more reliable than recognising six characters on an 8 kHz line —
  it needs **numeric-only codes** to be useful. Worth raising with the product owner.
- Recording storage and the retention policy (§13) are the OS side, not this service.
