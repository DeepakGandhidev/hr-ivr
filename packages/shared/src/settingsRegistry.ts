/**
 * Every tunable the product runs on, in one list.
 *
 * The admin panel renders its Platform settings page from this list, and the
 * portal and the worker read their values through it, so a setting exists in
 * exactly one place: add it here and it has a face, a type, bounds, a default
 * and a history.
 *
 * Precedence, for every key: a value saved in the admin panel, else the
 * server's environment variable (`env`), else `default`. So a fresh deploy
 * behaves exactly as the .env files say, and nothing changes until someone
 * changes it on purpose.
 *
 * `applies` is what the panel promises about timing:
 *   live       picked up within about 30 seconds, everywhere
 *   next_call  the next call that starts uses it (calls in progress keep theirs)
 *   restart    read once at start-up; restart the named app to apply
 */

import { COPY_SETTINGS } from './registry/copy.js';
import { AI_STEP_SETTINGS } from './registry/aiSteps.js';
import { EMAIL_SWITCH_SETTINGS } from './registry/emails.js';
import { WHATSAPP_SETTINGS, WHATSAPP_SWITCH_SETTINGS } from './registry/whatsapp.js';

export type SettingType =
  | 'int'
  | 'decimal'
  | 'bool'
  | 'select'
  | 'text'
  | 'textarea'
  | 'list'
  | 'secret';

export type SettingApp = 'web' | 'worker' | 'admin';

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDef {
  key: string;
  group: SettingGroupId;
  /** Sub-heading inside the group. */
  section: string;
  label: string;
  help?: string;
  type: SettingType;
  default: string | number | boolean | string[] | null;
  min?: number;
  max?: number;
  unit?: string;
  options?: SettingOption[];
  /** Max characters for text, textarea and each list item. */
  maxLength?: number;
  /** The environment variable this setting overrides at runtime. */
  env?: string;
  applies: 'live' | 'next_call' | 'restart';
  /** Which apps read it; shown so an admin knows what they are changing. */
  apps: SettingApp[];
  /** Only an Owner may change it (secrets always are). */
  ownerOnly?: boolean;
  /** A rule a saved text must satisfy, e.g. the disclosure must say it is an AI. */
  requires?: { pattern: string; message: string };
}

export type SettingGroupId =
  | 'calls'
  | 'scripts'
  | 'ai'
  | 'speech'
  | 'screening'
  | 'email'
  | 'billing'
  | 'messages'
  | 'brand'
  | 'limits'
  | 'features'
  | 'security'
  | 'integrations'
  | 'admin'
  | 'copy'
  | 'ai_steps';

export const SETTING_GROUPS: { id: SettingGroupId; label: string; blurb: string }[] = [
  { id: 'calls', label: 'Calls and interviews', blurb: 'How the phone line behaves: hours, capacity, timing, who may be interviewed.' },
  { id: 'scripts', label: 'What the agent says', blurb: 'Fixed lines spoken to candidates, outside the AI conversation.' },
  { id: 'ai', label: 'AI models', blurb: 'Which models run calls, reports and screening, and how long they may take.' },
  { id: 'speech', label: 'Speech and voice', blurb: 'Speech recognition, the voice, and when a pause counts as the end of an answer.' },
  { id: 'screening', label: 'Screening and scoring', blurb: 'CV screening thresholds, criteria weights and report badges.' },
  { id: 'email', label: 'Email ingestion', blurb: 'How connected mailboxes and forwarding addresses are read.' },
  { id: 'billing', label: 'Billing, trials and invoices', blurb: 'Tax, seller identity, renewals, overage and refunds.' },
  { id: 'messages', label: 'Emails and notifications', blurb: 'Sender names and the default templates new workspaces start with.' },
  { id: 'brand', label: 'Brand and contact', blurb: 'Product name, support address, phone number and public URLs.' },
  { id: 'limits', label: 'Limits and uploads', blurb: 'Field lengths, file sizes, page sizes and caps.' },
  { id: 'features', label: 'Feature switches', blurb: 'Turn whole features on or off, and which plans get them.' },
  { id: 'security', label: 'Security and sessions', blurb: 'Passwords and sign-in windows.' },
  { id: 'integrations', label: 'API keys and integrations', blurb: 'Credentials for AI, voice, telephony, email, WhatsApp, payments and mailbox sign-in. Owner only.' },
  { id: 'admin', label: 'Admin panel', blurb: 'Sessions, approvals and caps for this panel itself.' },
  { id: 'copy', label: 'Text and emails', blurb: 'Every message, label and email customers and candidates see. Empty or unchanged keeps the original wording.' },
  { id: 'ai_steps', label: 'AI call steps', blurb: 'What the AI is told to do at each step of a call. Changes reach the next call.' },
];

const GATE_OPTIONS: SettingOption[] = [
  { value: 'all', label: 'Every plan' },
  { value: 'growth', label: 'Growth and above' },
  { value: 'scale', label: 'Scale only' },
];

const W: SettingApp[] = ['web'];
const K: SettingApp[] = ['worker'];
const WK: SettingApp[] = ['web', 'worker'];
const A: SettingApp[] = ['admin'];

const CORE_SETTINGS: SettingDef[] = [
  // ---------------------------------------------------------------- calls
  { key: 'calls.operating_timezone', group: 'calls', section: 'Line hours', label: 'Time zone', type: 'text', default: 'Asia/Kolkata', env: 'OPERATING_TIMEZONE', applies: 'live', apps: K, maxLength: 64, help: 'IANA name, e.g. Asia/Kolkata.' },
  { key: 'calls.operating_days', group: 'calls', section: 'Line hours', label: 'Open on days', type: 'list', default: ['1', '2', '3', '4', '5', '6'], env: 'OPERATING_DAYS', applies: 'live', apps: K, help: 'Outside these days the line answers with the "closed" message. Stored as 0 = Sunday … 6 = Saturday.' },
  { key: 'calls.operating_start_hour', group: 'calls', section: 'Line hours', label: 'Opens at hour', type: 'int', default: 0, min: 0, max: 23, unit: 'h', env: 'OPERATING_START_HOUR', applies: 'live', apps: K },
  { key: 'calls.operating_end_hour', group: 'calls', section: 'Line hours', label: 'Closes at hour', type: 'int', default: 24, min: 1, max: 24, unit: 'h', env: 'OPERATING_END_HOUR', applies: 'live', apps: K, help: '24 = midnight. 0 to 24 is round the clock.' },
  { key: 'calls.operating_hours_label', group: 'calls', section: 'Line hours', label: 'Hours as read out', type: 'text', default: '', env: 'OPERATING_HOURS_LABEL', applies: 'live', apps: K, maxLength: 200, help: 'Leave empty to describe the hours above automatically.' },
  { key: 'calls.max_concurrent', group: 'calls', section: 'Capacity', label: 'Calls at once', type: 'int', default: 10, min: 1, max: 200, env: 'MAX_CONCURRENT_CALLS', applies: 'live', apps: K, help: 'Beyond this a caller hears the "all lines busy" message. Each call holds a speech, voice and AI session.' },
  { key: 'calls.number', group: 'calls', section: 'Capacity', label: 'Interview phone number', type: 'text', default: '+918031705255', env: 'PRATIBHA_NUMBER', applies: 'live', apps: WK, maxLength: 20, help: 'Shown to candidates and used to recognise the line. E.164 format.' },
  { key: 'calls.listen_only', group: 'calls', section: 'Who may be interviewed', label: 'Listen only (for phone-number verification)', type: 'bool', default: false, applies: 'next_call', apps: K, ownerOnly: true, help: 'The line answers but says nothing and only writes down what the caller says, so a verification code read out by Meta or a carrier comes through clean. No interviews happen while it is on: turn it off again straight after.' },
  { key: 'calls.verify_caller_email', group: 'calls', section: 'Who may be interviewed', label: 'Ask a recognised caller to confirm their email', type: 'bool', default: true, env: 'VERIFY_CALLER_EMAIL', applies: 'next_call', apps: K, help: 'Caller ID proves which phone called, not who holds it.' },
  { key: 'calls.require_shortlist_approval', group: 'calls', section: 'Who may be interviewed', label: 'Interview only shortlisted and approved candidates', type: 'bool', default: false, env: 'REQUIRE_SHORTLIST_APPROVAL', applies: 'next_call', apps: K },
  { key: 'calls.email_verify_attempts', group: 'calls', section: 'Who may be interviewed', label: 'Email confirmation attempts', type: 'int', default: 2, min: 1, max: 5, applies: 'next_call', apps: K },
  { key: 'calls.idle_hangup_seconds', group: 'calls', section: 'Timing', label: 'Hang up after silence of', type: 'int', default: 45, min: 10, max: 600, unit: 's', applies: 'next_call', apps: K },
  { key: 'calls.overrun_grace_seconds', group: 'calls', section: 'Timing', label: 'Allowed overrun past the interview length', type: 'int', default: 120, min: 0, max: 1800, unit: 's', applies: 'next_call', apps: K, help: 'After this the interview is wrapped up and ended.' },
  { key: 'calls.drain_seconds', group: 'calls', section: 'Timing', label: 'Wait for speech to finish before hanging up', type: 'int', default: 20, min: 2, max: 60, unit: 's', applies: 'next_call', apps: K },
  { key: 'calls.default_duration_minutes', group: 'calls', section: 'Timing', label: 'Interview length when a job sets none', type: 'int', default: 10, min: 2, max: 90, unit: 'min', applies: 'next_call', apps: WK },
  { key: 'calls.max_history_turns', group: 'calls', section: 'Conversation', label: 'Conversation turns the AI remembers', type: 'int', default: 40, min: 10, max: 200, applies: 'next_call', apps: K },
  { key: 'calls.max_tool_chain', group: 'calls', section: 'Conversation', label: 'Actions per caller turn before escalating', type: 'int', default: 4, min: 1, max: 12, applies: 'next_call', apps: K },
  { key: 'calls.closing_phrases', group: 'calls', section: 'Conversation', label: 'Goodbye phrases that end the call', type: 'list', default: ['have a good day', 'have a great day', 'have a nice day', 'have a good evening', 'have a great evening', 'have a nice evening', 'have a good one', 'have a great one', 'have a nice one', 'thank you for your time', 'thanks for your time', "that's all for now", "that's all from my side", "that's everything from my side", 'goodbye', 'good bye', 'take care', 'dhanyavaad', 'dhanyawad', 'shukriya', 'alvida'], applies: 'next_call', apps: K, maxLength: 80, help: 'Backstop if the AI says goodbye but forgets to hang up. Only used in the candidate questions stage.' },
  { key: 'interview.role_intro_seconds', group: 'calls', section: 'Interview plan estimate', label: 'Role introduction', type: 'int', default: 30, min: 5, max: 600, unit: 's', applies: 'live', apps: W },
  { key: 'interview.screener_seconds', group: 'calls', section: 'Interview plan estimate', label: 'Per screener question', type: 'int', default: 30, min: 5, max: 300, unit: 's', applies: 'live', apps: W },
  { key: 'interview.custom_question_seconds', group: 'calls', section: 'Interview plan estimate', label: 'Per custom question', type: 'int', default: 60, min: 5, max: 600, unit: 's', applies: 'live', apps: W },
  { key: 'interview.core_question_seconds', group: 'calls', section: 'Interview plan estimate', label: 'Per core question', type: 'int', default: 60, min: 5, max: 600, unit: 's', applies: 'live', apps: W },
  { key: 'interview.candidate_questions_seconds', group: 'calls', section: 'Interview plan estimate', label: "Candidate's own questions", type: 'int', default: 60, min: 0, max: 600, unit: 's', applies: 'live', apps: W },
  { key: 'interview.wrap_up_slack_minutes', group: 'calls', section: 'Interview plan estimate', label: 'Wrap-up slack', type: 'int', default: 1, min: 0, max: 15, unit: 'min', applies: 'live', apps: W },
  { key: 'interview.max_custom_questions', group: 'calls', section: 'Job interview defaults', label: 'Custom questions per job', type: 'int', default: 3, min: 0, max: 20, applies: 'live', apps: WK },
  { key: 'interview.default_min_questions', group: 'calls', section: 'Job interview defaults', label: 'Minimum questions', type: 'int', default: 6, min: 1, max: 40, applies: 'live', apps: WK },
  { key: 'interview.default_max_questions', group: 'calls', section: 'Job interview defaults', label: 'Maximum questions', type: 'int', default: 10, min: 1, max: 40, applies: 'live', apps: WK },
  { key: 'interview.default_hear_back_days', group: 'calls', section: 'Job interview defaults', label: 'Candidates hear back within', type: 'int', default: 3, min: 1, max: 30, unit: 'days', applies: 'live', apps: WK },
  { key: 'interview.default_difficulty', group: 'calls', section: 'Job interview defaults', label: 'Difficulty', type: 'select', default: 'moderate', options: [{ value: 'easy', label: 'Easy' }, { value: 'moderate', label: 'Moderate' }, { value: 'hard', label: 'Hard' }, { value: 'expert', label: 'Expert' }], applies: 'live', apps: WK },

  // ---------------------------------------------------------------- scripts
  { key: 'scripts.agent_name', group: 'scripts', section: 'Identity', label: 'Agent name', type: 'text', default: 'Pratibha', applies: 'next_call', apps: K, maxLength: 40, help: 'Used when a job does not set its own interviewer name.' },
  { key: 'scripts.disclosure', group: 'scripts', section: 'Identity', label: 'Opening disclosure (unknown callers)', type: 'textarea', default: "Hello, thanks for calling. My name is Pratibha, and I'm an AI hiring assistant — not a human. I'm here to run first-round conversations with shortlisted candidates. This call may be recorded for review.", applies: 'next_call', apps: K, maxLength: 600, help: 'Spoken before the AI has any control of the call. Must say it is an AI.', requires: { pattern: '\\b(AI|A\\.I\\.|artificial intelligence)\\b', message: 'must tell the caller they are speaking to an AI.' } },
  { key: 'scripts.closed', group: 'scripts', section: 'Line', label: 'Outside line hours', type: 'textarea', default: "Thanks for calling. Our first round calls are answered {hours}, India time. Please call back during those hours, and we'll be glad to speak with you.", applies: 'live', apps: K, maxLength: 600, help: '{hours} is replaced with the line hours.' },
  { key: 'scripts.busy', group: 'scripts', section: 'Line', label: 'All lines busy', type: 'textarea', default: 'Thanks for calling. All our lines are busy at the moment. Please call back in a few minutes.', applies: 'live', apps: K, maxLength: 600 },
  { key: 'scripts.speak_language', group: 'scripts', section: 'Line', label: 'Language of those two messages', type: 'text', default: 'en-IN', applies: 'live', apps: K, maxLength: 10 },
  { key: 'scripts.paused', group: 'scripts', section: 'Line', label: 'Workspace paused', type: 'textarea', default: "Thank you for calling. Interviews for this role are paused at the moment, so we can't go ahead today. The team will be in touch by email.", applies: 'next_call', apps: K, maxLength: 600 },
  { key: 'scripts.already_interviewed', group: 'scripts', section: 'Line', label: 'Caller already interviewed', type: 'textarea', default: 'We already have a completed interview on file for this role. Thank you for calling, and the team will be in touch by email if needed.', applies: 'next_call', apps: K, maxLength: 600 },
  { key: 'scripts.window_closed', group: 'scripts', section: 'Line', label: "Outside the job's call window", type: 'textarea', default: 'Thanks for calling. Our interview lines are currently closed. Please call back during the scheduled call window.', applies: 'next_call', apps: K, maxLength: 600 },
  { key: 'scripts.did_not_catch', group: 'scripts', section: 'Conversation', label: 'Did not catch that', type: 'text', default: "Sorry, I didn't quite catch that. Could you say it again?", applies: 'next_call', apps: K, maxLength: 300 },
  { key: 'scripts.something_wrong', group: 'scripts', section: 'Conversation', label: 'AI got stuck mid-call', type: 'textarea', default: "I'm sorry, something has gone wrong on my end. I'll flag this for the team and they'll be in touch by email.", applies: 'next_call', apps: K, maxLength: 600 },
  { key: 'scripts.time_up', group: 'scripts', section: 'Ending', label: 'Interview time is up', type: 'textarea', default: "That's all the time we have for the interview. Thank you for talking me through your experience — the team will review this and get back to you by email.", applies: 'next_call', apps: K, maxLength: 600 },
  { key: 'scripts.technical_failure', group: 'scripts', section: 'Ending', label: 'Technical failure', type: 'textarea', default: "I'm sorry, I'm having trouble on my end. Please call back, and I'll flag this for the team.", applies: 'next_call', apps: K, maxLength: 600 },
  { key: 'scripts.escalate_human', group: 'scripts', section: 'Escalation', label: 'Caller asks for a human', type: 'textarea', default: "Of course, that's no problem at all. I'll pass that on to the team and someone will be in touch with you by email. Thanks very much for your time today.", applies: 'next_call', apps: K, maxLength: 600 },
  { key: 'scripts.escalate_hostile', group: 'scripts', section: 'Escalation', label: 'Caller hostile or distressed', type: 'textarea', default: "I think it's best we leave it there for today. I'll pass this on to the team and someone will be in touch by email. Thank you for your time.", applies: 'next_call', apps: K, maxLength: 600 },
  { key: 'scripts.escalate_line', group: 'scripts', section: 'Escalation', label: 'Line too poor', type: 'textarea', default: "I'm sorry, the line isn't clear enough for me to do this properly. Please call back on a better connection. Thanks for your patience.", applies: 'next_call', apps: K, maxLength: 600 },
  { key: 'scripts.escalate_identity', group: 'scripts', section: 'Escalation', label: 'Identity does not match', type: 'textarea', default: "I'm sorry, I'm not able to continue with this call. I'll pass it on to the team and they'll follow up by email. Thank you.", applies: 'next_call', apps: K, maxLength: 600 },
  { key: 'scripts.escalate_other', group: 'scripts', section: 'Escalation', label: 'Any other reason', type: 'textarea', default: "I'm sorry, I'm not able to continue with this call. I'll pass it on to the team and someone will be in touch by email. Thank you for your time.", applies: 'next_call', apps: K, maxLength: 600 },

  // ---------------------------------------------------------------- ai
  { key: 'ai.call_model', group: 'ai', section: 'Live calls', label: 'Model on the call', type: 'text', default: 'claude-haiku-4-5', env: 'ANTHROPIC_MODEL', applies: 'next_call', apps: K, maxLength: 100, help: 'Fast matters more than clever: it picks the next question.' },
  { key: 'ai.call_timeout_ms', group: 'ai', section: 'Live calls', label: 'Give up on a turn after', type: 'int', default: 12000, min: 2000, max: 60000, unit: 'ms', env: 'ANTHROPIC_TIMEOUT_MS', applies: 'next_call', apps: K },
  { key: 'ai.call_max_retries', group: 'ai', section: 'Live calls', label: 'Retries per turn', type: 'int', default: 1, min: 0, max: 3, env: 'ANTHROPIC_MAX_RETRIES', applies: 'next_call', apps: K },
  { key: 'ai.call_max_tokens', group: 'ai', section: 'Live calls', label: 'Max tokens per turn', type: 'int', default: 600, min: 100, max: 4000, applies: 'next_call', apps: K },
  { key: 'ai.call_temperature', group: 'ai', section: 'Live calls', label: 'Temperature on the call', type: 'decimal', default: 0.3, min: 0, max: 1, applies: 'next_call', apps: K },
  { key: 'ai.analysis_model', group: 'ai', section: 'Reports', label: 'Model for the post-call report', type: 'text', default: 'claude-opus-5', env: 'ANTHROPIC_ANALYSIS_MODEL', applies: 'live', apps: K, maxLength: 100 },
  { key: 'ai.analysis_max_tokens', group: 'ai', section: 'Reports', label: 'Max tokens for a report', type: 'int', default: 16000, min: 1000, max: 64000, applies: 'live', apps: K },
  { key: 'ai.analysis_temperature', group: 'ai', section: 'Reports', label: 'Temperature for reports', type: 'decimal', default: 0, min: 0, max: 1, applies: 'live', apps: K },
  { key: 'ai.portal_model', group: 'ai', section: 'Portal (screening, job descriptions)', label: 'Model in the portal', type: 'text', default: 'kimi-k2.6', env: 'ANTHROPIC_MODEL', applies: 'live', apps: W, maxLength: 100, help: 'Shares ANTHROPIC_MODEL with the worker in .env; set here to choose separately.' },
  { key: 'ai.screening_max_tokens', group: 'ai', section: 'Portal (screening, job descriptions)', label: 'Max tokens for CV screening', type: 'int', default: 1024, min: 200, max: 8000, applies: 'live', apps: WK },
  { key: 'ai.screening_temperature', group: 'ai', section: 'Portal (screening, job descriptions)', label: 'Temperature for CV screening', type: 'decimal', default: 0.2, min: 0, max: 1, applies: 'live', apps: K },
  { key: 'ai.jd_max_tokens', group: 'ai', section: 'Portal (screening, job descriptions)', label: 'Max tokens for a job description', type: 'int', default: 2048, min: 200, max: 8000, applies: 'live', apps: W },
  { key: 'ai.mock_mode', group: 'ai', section: 'Testing', label: 'Mock AI (no real model calls)', type: 'bool', default: false, env: 'MOCK_MODE', applies: 'live', apps: WK, ownerOnly: true, help: 'For testing only. Never on in production.' },

  // ---------------------------------------------------------------- speech
  { key: 'speech.stt_model', group: 'speech', section: 'Speech recognition (Sarvam)', label: 'Model', type: 'text', default: 'saaras:v3-realtime', env: 'SARVAM_STT_MODEL', applies: 'next_call', apps: K, maxLength: 60 },
  { key: 'speech.stt_language', group: 'speech', section: 'Speech recognition (Sarvam)', label: 'Language', type: 'text', default: 'auto', env: 'SARVAM_STT_LANGUAGE', applies: 'next_call', apps: K, maxLength: 20, help: '"auto" lets a candidate switch between English and Hindi.' },
  { key: 'speech.stt_mode', group: 'speech', section: 'Speech recognition (Sarvam)', label: 'Mode', type: 'select', default: 'transcribe', options: [{ value: 'transcribe', label: 'Transcribe' }, { value: 'codemix', label: 'Code-mix' }, { value: 'translate', label: 'Translate' }], env: 'SARVAM_STT_MODE', applies: 'next_call', apps: K },
  { key: 'speech.stt_stream_type', group: 'speech', section: 'Speech recognition (Sarvam)', label: 'Stream type', type: 'select', default: 'fast', options: [{ value: 'fast', label: 'Fast' }, { value: 'accurate', label: 'Accurate' }], env: 'SARVAM_STT_STREAM_TYPE', applies: 'next_call', apps: K },
  { key: 'speech.stt_threshold', group: 'speech', section: 'Speech recognition (Sarvam)', label: 'Speech threshold', type: 'decimal', default: 0.3, min: 0, max: 1, env: 'SARVAM_STT_THRESHOLD', applies: 'next_call', apps: K },
  { key: 'speech.stt_silence_ms', group: 'speech', section: 'Speech recognition (Sarvam)', label: 'End of answer after a pause of', type: 'int', default: 800, min: 200, max: 5000, unit: 'ms', env: 'SARVAM_STT_SILENCE_MS', applies: 'next_call', apps: K, help: 'Too short and candidates get cut off mid-thought.' },
  { key: 'speech.stt_min_speech_ms', group: 'speech', section: 'Speech recognition (Sarvam)', label: 'Ignore sounds shorter than', type: 'int', default: 250, min: 50, max: 2000, unit: 'ms', env: 'SARVAM_STT_MIN_SPEECH_MS', applies: 'next_call', apps: K },
  { key: 'speech.tts_provider', group: 'speech', section: 'Voice', label: 'Voice provider', type: 'select', default: 'sarvam', options: [{ value: 'sarvam', label: 'Sarvam' }, { value: 'elevenlabs', label: 'ElevenLabs' }], env: 'TTS_PROVIDER', applies: 'next_call', apps: K },
  { key: 'speech.sarvam_tts_model', group: 'speech', section: 'Voice', label: 'Sarvam voice model', type: 'text', default: 'bulbul:v3', env: 'SARVAM_TTS_MODEL', applies: 'next_call', apps: K, maxLength: 60 },
  { key: 'speech.sarvam_speaker', group: 'speech', section: 'Voice', label: 'Sarvam speaker', type: 'text', default: 'ritu', env: 'SARVAM_TTS_SPEAKER', applies: 'next_call', apps: K, maxLength: 40 },
  { key: 'speech.sarvam_language', group: 'speech', section: 'Voice', label: 'Sarvam voice language', type: 'text', default: 'en-IN', env: 'SARVAM_TTS_LANGUAGE', applies: 'next_call', apps: K, maxLength: 10 },
  { key: 'speech.sarvam_pace', group: 'speech', section: 'Voice', label: 'Sarvam speaking pace', type: 'decimal', default: 1.0, min: 0.5, max: 2, env: 'SARVAM_TTS_PACE', applies: 'next_call', apps: K },
  { key: 'speech.elevenlabs_model', group: 'speech', section: 'Voice', label: 'ElevenLabs model', type: 'text', default: 'eleven_flash_v2_5', env: 'ELEVENLABS_TTS_MODEL', applies: 'next_call', apps: K, maxLength: 60 },
  { key: 'speech.elevenlabs_voice_id', group: 'speech', section: 'Voice', label: 'ElevenLabs voice id', type: 'text', default: '', env: 'ELEVENLABS_VOICE_ID', applies: 'next_call', apps: K, maxLength: 60 },
  { key: 'speech.elevenlabs_stability', group: 'speech', section: 'Voice', label: 'ElevenLabs stability', type: 'decimal', default: 0.5, min: 0, max: 1, env: 'ELEVENLABS_STABILITY', applies: 'next_call', apps: K },
  { key: 'speech.elevenlabs_similarity', group: 'speech', section: 'Voice', label: 'ElevenLabs similarity boost', type: 'decimal', default: 0.75, min: 0, max: 1, env: 'ELEVENLABS_SIMILARITY_BOOST', applies: 'next_call', apps: K },
  { key: 'speech.elevenlabs_speed', group: 'speech', section: 'Voice', label: 'ElevenLabs speed', type: 'decimal', default: 1.0, min: 0.7, max: 1.2, env: 'ELEVENLABS_SPEED', applies: 'next_call', apps: K },
  { key: 'speech.vad_ratio', group: 'speech', section: 'Barge-in (caller talks over the agent)', label: 'Loudness ratio', type: 'decimal', default: 3.0, min: 1, max: 10, env: 'VAD_RATIO', applies: 'next_call', apps: K },
  { key: 'speech.vad_floor', group: 'speech', section: 'Barge-in (caller talks over the agent)', label: 'Noise floor', type: 'decimal', default: 0.01, min: 0, max: 0.2, env: 'VAD_FLOOR', applies: 'next_call', apps: K },
  { key: 'speech.vad_speech_frames', group: 'speech', section: 'Barge-in (caller talks over the agent)', label: 'Frames of speech to interrupt', type: 'int', default: 3, min: 1, max: 50, env: 'VAD_SPEECH_FRAMES', applies: 'next_call', apps: K },
  { key: 'speech.vad_silence_frames', group: 'speech', section: 'Barge-in (caller talks over the agent)', label: 'Frames of silence to resume', type: 'int', default: 25, min: 1, max: 200, env: 'VAD_SILENCE_FRAMES', applies: 'next_call', apps: K },

  // ---------------------------------------------------------------- screening
  { key: 'screening.suggest_threshold', group: 'screening', section: 'Shortlisting', label: 'Suggest for shortlist at score', type: 'int', default: 70, min: 1, max: 100, applies: 'live', apps: W, help: 'Drives the Suggested chip and the green score bars. A job with its own threshold keeps it.' },
  { key: 'screening.must_have_weight', group: 'screening', section: 'Criteria weights', label: 'Must-have weight', type: 'int', default: 5, min: 1, max: 10, applies: 'next_call', apps: K },
  { key: 'screening.nice_to_have_weight', group: 'screening', section: 'Criteria weights', label: 'Nice-to-have weight', type: 'int', default: 3, min: 0, max: 10, applies: 'next_call', apps: K, help: 'Keep it below the must-have weight: the report treats anything at or above that weight as a must-have.' },
  { key: 'screening.queue_interval_seconds', group: 'screening', section: 'Automatic screening', label: 'Screening queue runs every', type: 'int', default: 60, min: 10, max: 3600, unit: 's', applies: 'restart', apps: W },
  { key: 'pipeline.auto_screen_batch', group: 'screening', section: 'Automatic screening', label: 'Candidates per screening run', type: 'int', default: 10, min: 1, max: 200, applies: 'live', apps: W },
  { key: 'pipeline.junk_hint', group: 'screening', section: 'Pipeline', label: 'Junk hint on the Pipeline', type: 'bool', default: true, applies: 'live', apps: W, help: 'No phone, no job and a subject-sourced name together suggest "Not an application".' },
  { key: 'pipeline.junk_rule', group: 'screening', section: 'Pipeline', label: 'Signals that together mean junk', type: 'list', default: ['no_phone', 'no_job', 'subject_name'], applies: 'live', apps: W, help: 'Any of: no_phone, no_job, subject_name.' },
  { key: 'report.score_gap_threshold', group: 'screening', section: 'Reports', label: 'Score gap badge from', type: 'decimal', default: 2.0, min: 0.5, max: 10, applies: 'live', apps: W },
  { key: 'report.evidence_chars', group: 'screening', section: 'Reports', label: 'Evidence quote length', type: 'int', default: 400, min: 50, max: 2000, unit: 'chars', applies: 'live', apps: K },

  // ---------------------------------------------------------------- email
  { key: 'email.poll_interval_minutes', group: 'email', section: 'Mailboxes', label: 'Check every mailbox every', type: 'int', default: 10, min: 1, max: 120, unit: 'min', env: 'EMAIL_POLL_INTERVAL_MS', applies: 'restart', apps: K, help: 'A safety net: new mail usually arrives in seconds through IMAP IDLE.' },
  { key: 'email.first_lookback_days', group: 'email', section: 'Mailboxes', label: 'On first connect, import mail from the last', type: 'int', default: 7, min: 0, max: 90, unit: 'days', applies: 'live', apps: K },
  { key: 'email.max_per_poll', group: 'email', section: 'Mailboxes', label: 'Messages per check', type: 'int', default: 50, min: 5, max: 500, applies: 'live', apps: K },
  { key: 'email.failure_rolloff', group: 'email', section: 'Mailboxes', label: 'Give up on a failing mailbox after', type: 'int', default: 12, min: 3, max: 50, unit: 'failures', applies: 'live', apps: K, help: 'Retries back off up to 6 hours first; a host that keeps refusing logins may ban the server.' },
  { key: 'email.route_threshold', group: 'email', section: 'Routing to jobs', label: 'Match a job when confidence is at least', type: 'int', default: 45, min: 1, max: 100, applies: 'live', apps: K, help: 'For "All jobs" mailboxes. Below it, mail goes to the fallback job.' },
  { key: 'email.robot_senders', group: 'email', section: 'Spam filter', label: 'Extra sender names to ignore', type: 'list', default: [], applies: 'live', apps: K, maxLength: 80, help: 'Added to the built-in list (noreply, mailer-daemon …). e.g. "alerts", "billing".' },
  { key: 'email.robot_domains', group: 'email', section: 'Spam filter', label: 'Extra domains to ignore', type: 'list', default: [], applies: 'live', apps: K, maxLength: 120, help: 'Mail from these domains is never an application.' },
  { key: 'email.application_terms', group: 'email', section: 'Spam filter', label: 'Extra words that mark an application', type: 'list', default: [], applies: 'live', apps: K, maxLength: 80, help: 'e.g. "biodata", "candidature".' },
  { key: 'email.inbound_domain', group: 'email', section: 'Forwarding', label: 'Forwarding domain', type: 'text', default: 'in.pratibha.tech', env: 'INBOUND_EMAIL_DOMAIN', applies: 'live', apps: WK, maxLength: 120, help: 'Its MX record must point at the server. Existing addresses stop working if changed.' },
  { key: 'email.inbound_max_mb', group: 'email', section: 'Forwarding', label: 'Largest forwarded email', type: 'int', default: 30, min: 1, max: 50, unit: 'MB', applies: 'restart', apps: K },

  // ---------------------------------------------------------------- billing
  { key: 'billing.gst_rate_percent', group: 'billing', section: 'Tax and invoices', label: 'GST rate', type: 'decimal', default: 18, min: 0, max: 40, unit: '%', applies: 'live', apps: W, ownerOnly: true },
  { key: 'billing.sac_code', group: 'billing', section: 'Tax and invoices', label: 'SAC code', type: 'text', default: '998319', applies: 'live', apps: W, maxLength: 10, ownerOnly: true },
  { key: 'billing.seller_name', group: 'billing', section: 'Tax and invoices', label: 'Seller legal name', type: 'text', default: 'Promonkey Technologies LLP', env: 'INVOICE_SELLER_NAME', applies: 'live', apps: ['web', 'admin'], maxLength: 200, ownerOnly: true },
  { key: 'billing.seller_gstin', group: 'billing', section: 'Tax and invoices', label: 'Seller GSTIN', type: 'text', default: '', env: 'INVOICE_SELLER_GSTIN', applies: 'live', apps: ['web', 'admin'], maxLength: 15, ownerOnly: true },
  { key: 'billing.seller_address', group: 'billing', section: 'Tax and invoices', label: 'Seller address', type: 'textarea', default: '', env: 'INVOICE_SELLER_ADDRESS', applies: 'live', apps: ['web', 'admin'], maxLength: 400, ownerOnly: true },
  { key: 'billing.seller_state', group: 'billing', section: 'Tax and invoices', label: 'Seller state', type: 'text', default: 'Karnataka', env: 'INVOICE_SELLER_STATE', applies: 'live', apps: ['web', 'admin'], maxLength: 60, ownerOnly: true, help: 'Decides CGST+SGST (same state) or IGST.' },
  { key: 'billing.invoice_prefix', group: 'billing', section: 'Tax and invoices', label: 'Invoice number prefix', type: 'text', default: 'PMT', env: 'INVOICE_NUMBER_PREFIX', applies: 'live', apps: ['web', 'admin'], maxLength: 10, ownerOnly: true },
  { key: 'billing.quota_warning_percent', group: 'billing', section: 'Overage', label: 'Warn customers at', type: 'int', default: 80, min: 10, max: 99, unit: '% used', applies: 'live', apps: W },
  { key: 'billing.average_interview_minutes', group: 'billing', section: 'Overage', label: 'Minutes per interview (for "≈ N interviews")', type: 'int', default: 10, min: 1, max: 90, applies: 'live', apps: W },
  { key: 'billing.renew_ahead_days', group: 'billing', section: 'Renewals', label: 'Raise a renewal this many days early', type: 'int', default: 3, min: 2, max: 14, unit: 'days', applies: 'live', apps: W, ownerOnly: true, help: 'Mandate debits need notice; at least 2 days.' },
  { key: 'billing.renewal_retry_days', group: 'billing', section: 'Renewals', label: 'Retry a failed renewal for', type: 'int', default: 7, min: 0, max: 30, unit: 'days', applies: 'live', apps: W, ownerOnly: true },
  { key: 'billing.mandate_max_inr', group: 'billing', section: 'Renewals', label: 'AutoPay mandate ceiling', type: 'int', default: 15000, min: 1000, max: 1000000, unit: '₹', env: 'CASHFREE_MANDATE_MAX_INR', applies: 'live', apps: W, ownerOnly: true, help: 'Above ₹15,000 UPI and card mandates need extra authentication (AFA).' },
  { key: 'billing.data_retention_days', group: 'billing', section: 'Cancellation', label: 'Delete a cancelled workspace after', type: 'int', default: 30, min: 7, max: 365, unit: 'days', applies: 'live', apps: W, ownerOnly: true },
  { key: 'refund.window_days', group: 'billing', section: 'Refunds', label: 'Refund window', type: 'int', default: 7, min: 0, max: 60, unit: 'days', applies: 'live', apps: A, ownerOnly: true },
  { key: 'refund.first_payment_max_usage_percent', group: 'billing', section: 'Refunds', label: 'Refundable if usage is under', type: 'int', default: 20, min: 0, max: 100, unit: '%', applies: 'live', apps: A, ownerOnly: true },

  // ---------------------------------------------------------------- messages
  { key: 'messages.smtp_host', group: 'messages', section: 'Platform mailbox (SMTP)', label: 'SMTP server', type: 'text', default: 'smtp.hostinger.com', env: 'PLATFORM_SMTP_HOST', applies: 'live', apps: ['web', 'worker', 'admin'], maxLength: 200, ownerOnly: true },
  { key: 'messages.smtp_port', group: 'messages', section: 'Platform mailbox (SMTP)', label: 'SMTP port', type: 'int', default: 465, min: 1, max: 65535, env: 'PLATFORM_SMTP_PORT', applies: 'live', apps: ['web', 'worker', 'admin'], ownerOnly: true, help: '465 = SSL (Hostinger). 587 = STARTTLS.' },
  { key: 'messages.smtp_user', group: 'messages', section: 'Platform mailbox (SMTP)', label: 'Mailbox (sends as)', type: 'text', default: '', env: 'PLATFORM_SMTP_USER', applies: 'live', apps: ['web', 'worker', 'admin'], maxLength: 200, ownerOnly: true, help: 'The full address, e.g. info@pratibha.tech. Every email is sent from it.' },
  { key: 'integrations.smtp_password', group: 'messages', section: 'Platform mailbox (SMTP)', label: 'Mailbox password', type: 'secret', default: null, env: 'PLATFORM_SMTP_PASSWORD', applies: 'live', apps: ['web', 'worker', 'admin'], help: 'Easiest from the Email page, which checks it with the mail server before saving.' },
  { key: 'messages.smtp_from_name', group: 'messages', section: 'Platform mailbox (SMTP)', label: 'Sender name', type: 'text', default: '', applies: 'live', apps: ['web', 'worker', 'admin'], maxLength: 80, help: 'Shown as the sender of system emails. Empty uses the product name. Workspace emails show "<Company> via <product>".' },
  { key: 'messages.sender_name', group: 'messages', section: 'Senders', label: 'Product name in sender', type: 'text', default: 'Pratibha', applies: 'live', apps: W, maxLength: 40, help: 'Candidate emails show "<Company> via <this>" as the sender.' },
  { key: 'messages.transport', group: 'messages', section: 'Senders', label: 'Candidate email goes through', type: 'select', default: 'auto', options: [{ value: 'auto', label: "The workspace's own mailbox when connected, else Pratibha's" }, { value: 'platform', label: "Always Pratibha's mailbox" }], applies: 'live', apps: W },
  { key: 'messages.invite_subject', group: 'messages', section: 'Default templates for new workspaces', label: 'Interview invite: subject', type: 'text', default: '', applies: 'live', apps: ['web', 'admin'], maxLength: 200, help: 'Empty keeps the built-in template.' },
  { key: 'messages.invite_body', group: 'messages', section: 'Default templates for new workspaces', label: 'Interview invite: body', type: 'textarea', default: '', applies: 'live', apps: ['web', 'admin'], maxLength: 5000 },
  { key: 'messages.rejection_subject', group: 'messages', section: 'Default templates for new workspaces', label: 'Rejection: subject', type: 'text', default: '', applies: 'live', apps: ['web', 'admin'], maxLength: 200 },
  { key: 'messages.rejection_body', group: 'messages', section: 'Default templates for new workspaces', label: 'Rejection: body', type: 'textarea', default: '', applies: 'live', apps: ['web', 'admin'], maxLength: 5000 },
  { key: 'messages.reminder_subject', group: 'messages', section: 'Default templates for new workspaces', label: 'Reminder: subject', type: 'text', default: '', applies: 'live', apps: ['web', 'admin'], maxLength: 200 },
  { key: 'messages.reminder_body', group: 'messages', section: 'Default templates for new workspaces', label: 'Reminder: body', type: 'textarea', default: '', applies: 'live', apps: ['web', 'admin'], maxLength: 5000 },
  { key: 'messages.protocol_instruction', group: 'messages', section: 'Default templates for new workspaces', label: 'Default interviewer instruction', type: 'textarea', default: '', applies: 'live', apps: ['web', 'admin'], maxLength: 5000, help: 'Empty keeps the built-in instruction.' },
  { key: 'messages.shortlist_subject', group: 'messages', section: 'Team notifications', label: 'Shortlist ready: subject', type: 'text', default: '', applies: 'live', apps: W, maxLength: 200, help: 'Empty keeps the built-in wording. {job} and {candidate} are filled in.' },

  // ---------------------------------------------------------------- brand
  { key: 'brand.product_name', group: 'brand', section: 'Product', label: 'Product name', type: 'text', default: 'Pratibha', applies: 'live', apps: ['web', 'admin'], maxLength: 40 },
  { key: 'brand.site_title', group: 'brand', section: 'Product', label: 'Browser title', type: 'text', default: 'Pratibha — AI Hiring Agent', applies: 'restart', apps: W, maxLength: 100, help: 'Pages built ahead of time keep the old title until the next deploy.' },
  { key: 'brand.site_description', group: 'brand', section: 'Product', label: 'Site description', type: 'text', default: 'Screen and interview candidates automatically, from application to shortlist.', applies: 'restart', apps: W, maxLength: 300, help: 'Pages built ahead of time keep the old description until the next deploy.' },
  { key: 'brand.support_email', group: 'brand', section: 'Contact', label: 'Support email', type: 'text', default: 'start@pratibha.tech', applies: 'live', apps: ['web', 'admin'], maxLength: 120, help: 'Shown on paused workspaces, payment problems and data requests.' },
  { key: 'brand.app_url', group: 'brand', section: 'URLs', label: 'Portal URL', type: 'text', default: 'https://pratibha.tech', env: 'NEXT_PUBLIC_APP_URL', applies: 'live', apps: WK, maxLength: 200, ownerOnly: true, help: 'Used in links in emails (including the call line’s) and payment redirects. Must match the OAuth redirect URIs.' },
  { key: 'brand.public_base_url', group: 'brand', section: 'URLs', label: 'Public base URL (worker and logos)', type: 'text', default: 'https://hiring.promonkey.tech', env: 'PUBLIC_BASE_URL', applies: 'live', apps: WK, maxLength: 200, ownerOnly: true },
  { key: 'brand.public_ws_url', group: 'brand', section: 'URLs', label: 'Call audio stream URL', type: 'text', default: 'wss://hiring.promonkey.tech/pratibha/stream', env: 'PUBLIC_WS_URL', applies: 'next_call', apps: K, maxLength: 200, ownerOnly: true, help: 'Must be wss:// for a real number.' },
  { key: 'brand.whatsapp_share_text', group: 'brand', section: 'Copy', label: 'WhatsApp share text', type: 'text', default: '– apply here:', applies: 'live', apps: W, maxLength: 120 },

  // ---------------------------------------------------------------- limits
  { key: 'lists.page_size', group: 'limits', section: 'Lists', label: 'Rows per page', type: 'int', default: 25, min: 10, max: 200, applies: 'live', apps: ['web', 'admin'] },
  { key: 'company.description_cap', group: 'limits', section: 'Company profile', label: 'Description length', type: 'int', default: 600, min: 100, max: 5000, unit: 'chars', applies: 'live', apps: W },
  { key: 'company.legal_name_max', group: 'limits', section: 'Company profile', label: 'Legal name length', type: 'int', default: 200, min: 20, max: 500, unit: 'chars', applies: 'live', apps: W },
  { key: 'company.address_line_max', group: 'limits', section: 'Company profile', label: 'Address line length', type: 'int', default: 300, min: 20, max: 1000, unit: 'chars', applies: 'live', apps: W },
  { key: 'company.city_max', group: 'limits', section: 'Company profile', label: 'City length', type: 'int', default: 100, min: 10, max: 300, unit: 'chars', applies: 'live', apps: W },
  { key: 'company.logo_max_bytes', group: 'limits', section: 'Company profile', label: 'Logo file size', type: 'int', default: 2097152, min: 102400, max: 10485760, unit: 'bytes', applies: 'live', apps: W },
  { key: 'limits.cv_max_mb', group: 'limits', section: 'CV uploads', label: 'Largest CV file', type: 'int', default: 15, min: 1, max: 50, unit: 'MB', applies: 'live', apps: WK },
  { key: 'limits.cv_parse_timeout_seconds', group: 'limits', section: 'CV uploads', label: 'Give up reading a CV after', type: 'int', default: 30, min: 5, max: 180, unit: 's', applies: 'live', apps: WK },
  { key: 'limits.must_haves_max', group: 'limits', section: 'Jobs', label: 'Must-haves per job', type: 'int', default: 20, min: 1, max: 100, applies: 'live', apps: W },
  { key: 'limits.good_to_haves_max', group: 'limits', section: 'Jobs', label: 'Good-to-haves per job', type: 'int', default: 20, min: 1, max: 100, applies: 'live', apps: W },

  // ---------------------------------------------------------------- features
  { key: 'gate.portal_posts', group: 'features', section: 'Plan gates', label: 'Portal posts, Naukri and LinkedIn', type: 'select', default: 'all', options: GATE_OPTIONS, applies: 'live', apps: W },
  { key: 'gate.interview_tuning', group: 'features', section: 'Plan gates', label: 'Interview tuning: screeners, salary policy, custom questions', type: 'select', default: 'all', options: GATE_OPTIONS, applies: 'live', apps: W },
  { key: 'features.paid_signup', group: 'features', section: 'Sign-up and billing', label: 'Pay for the first month at sign-up (no free trial)', type: 'bool', default: false, env: 'PAID_SIGNUP', applies: 'live', apps: W, ownerOnly: true },
  { key: 'features.payment_provider', group: 'features', section: 'Sign-up and billing', label: 'Payment provider', type: 'select', default: 'manual', options: [{ value: 'cashfree', label: 'Cashfree' }, { value: 'manual', label: 'Manual (record payments by hand)' }], env: 'PAYMENT_PROVIDER', applies: 'live', apps: W, ownerOnly: true },
  { key: 'features.renewals_enabled', group: 'features', section: 'Sign-up and billing', label: 'Automatic renewals', type: 'bool', default: true, applies: 'live', apps: W, ownerOnly: true },
  { key: 'features.screening_queue_enabled', group: 'features', section: 'Background jobs', label: 'Automatic CV screening', type: 'bool', default: true, applies: 'live', apps: W },
  { key: 'features.two_factor', group: 'features', section: 'Portal', label: 'Two-step verification card in My profile', type: 'bool', default: false, env: 'NEXT_PUBLIC_FEATURE_TWO_FACTOR', applies: 'live', apps: W },

  // ---------------------------------------------------------------- security
  { key: 'security.password_min_length', group: 'security', section: 'Portal passwords', label: 'Minimum length when changing a password', type: 'int', default: 10, min: 8, max: 64, unit: 'chars', applies: 'live', apps: W },
  { key: 'security.signup_password_min_length', group: 'security', section: 'Portal passwords', label: 'Minimum length at sign-up', type: 'int', default: 8, min: 8, max: 64, unit: 'chars', applies: 'live', apps: W },
  { key: 'security.plivo_verify_signature', group: 'security', section: 'Phone line', label: 'Verify that calls really come from Plivo', type: 'bool', default: true, env: 'PLIVO_VERIFY_SIGNATURE', applies: 'next_call', apps: K, ownerOnly: true, help: 'Off only for local testing.' },

  // ---------------------------------------------------------------- integrations
  { key: 'integrations.anthropic_api_key', group: 'integrations', section: 'AI', label: 'AI API key', type: 'secret', default: null, env: 'ANTHROPIC_API_KEY', applies: 'next_call', apps: WK },
  { key: 'integrations.anthropic_base_url', group: 'integrations', section: 'AI', label: 'AI endpoint', type: 'text', default: '', env: 'ANTHROPIC_BASE_URL', applies: 'next_call', apps: WK, maxLength: 200, ownerOnly: true, help: 'Empty = api.anthropic.com. The key must belong to this endpoint.' },
  { key: 'integrations.sarvam_api_key', group: 'integrations', section: 'Voice', label: 'Sarvam API key', type: 'secret', default: null, env: 'SARVAM_API_KEY', applies: 'next_call', apps: K },
  { key: 'integrations.elevenlabs_api_key', group: 'integrations', section: 'Voice', label: 'ElevenLabs API key', type: 'secret', default: null, env: 'ELEVENLABS_API_KEY', applies: 'next_call', apps: K },
  { key: 'integrations.plivo_auth_token', group: 'integrations', section: 'Phone line', label: 'Plivo auth token', type: 'secret', default: null, env: 'PLIVO_AUTH_TOKEN', applies: 'next_call', apps: K },
  { key: 'integrations.cashfree_env', group: 'integrations', section: 'Payments', label: 'Cashfree environment', type: 'select', default: 'sandbox', options: [{ value: 'sandbox', label: 'Sandbox (test)' }, { value: 'production', label: 'Production (real money)' }], env: 'CASHFREE_ENV', applies: 'live', apps: W, ownerOnly: true },
  { key: 'integrations.cashfree_client_id', group: 'integrations', section: 'Payments', label: 'Cashfree client id', type: 'text', default: '', env: 'CASHFREE_CLIENT_ID', applies: 'live', apps: W, maxLength: 200, ownerOnly: true },
  { key: 'integrations.cashfree_client_secret', group: 'integrations', section: 'Payments', label: 'Cashfree client secret', type: 'secret', default: null, env: 'CASHFREE_CLIENT_SECRET', applies: 'live', apps: W },
  { key: 'integrations.google_client_id', group: 'integrations', section: 'Mailbox sign-in', label: 'Google client id', type: 'text', default: '', env: 'GOOGLE_CLIENT_ID', applies: 'live', apps: WK, maxLength: 200, ownerOnly: true },
  { key: 'integrations.google_client_secret', group: 'integrations', section: 'Mailbox sign-in', label: 'Google client secret', type: 'secret', default: null, env: 'GOOGLE_CLIENT_SECRET', applies: 'live', apps: WK },
  { key: 'integrations.microsoft_client_id', group: 'integrations', section: 'Mailbox sign-in', label: 'Microsoft client id', type: 'text', default: '', env: 'MICROSOFT_CLIENT_ID', applies: 'live', apps: WK, maxLength: 200, ownerOnly: true },
  { key: 'integrations.microsoft_client_secret', group: 'integrations', section: 'Mailbox sign-in', label: 'Microsoft client secret', type: 'secret', default: null, env: 'MICROSOFT_CLIENT_SECRET', applies: 'live', apps: WK },

  { key: 'integrations.saarthi_site_key', group: 'integrations', section: 'Saarthi chat assistant', label: 'Saarthi site key', type: 'text', default: '', applies: 'live', apps: W, maxLength: 100, ownerOnly: true, help: 'From the Saarthi console, Widget & SDK (starts with ws_). Public. Empty turns the chat off everywhere.' },
  { key: 'integrations.saarthi_sdk_secret', group: 'integrations', section: 'Saarthi chat assistant', label: 'Saarthi SDK secret', type: 'secret', default: null, env: 'SAARTHI_SDK_SECRET', applies: 'live', apps: W, help: 'Lets the chat know who a signed-in customer is. Without it the portal chat is anonymous.' },
  { key: 'integrations.saarthi_widget_url', group: 'integrations', section: 'Saarthi chat assistant', label: 'Saarthi widget script', type: 'text', default: 'https://saarthi-api-promonkey.onrender.com/widget/v1.js', applies: 'live', apps: W, maxLength: 300, ownerOnly: true, requires: { pattern: '^https://', message: 'must be an https:// address.' } },
  { key: 'features.saarthi_public', group: 'features', section: 'Saarthi chat assistant', label: 'Chat on the website, sign-in pages and job pages', type: 'bool', default: true, applies: 'live', apps: W, help: 'Visitors chat anonymously. Needs the Saarthi site key.' },
  { key: 'features.saarthi_portal', group: 'features', section: 'Saarthi chat assistant', label: 'Chat inside the portal for signed-in customers', type: 'bool', default: true, applies: 'live', apps: W, help: 'Saarthi greets them by name and knows their workspace, role and plan when the SDK secret is set.' },

  // ---------------------------------------------------------------- admin
  { key: 'admin.goodwill_cap_minutes', group: 'admin', section: 'Support', label: 'Goodwill minutes Support may grant', type: 'int', default: 100, min: 0, max: 10000, unit: 'min', applies: 'live', apps: A, ownerOnly: true },
  { key: 'admin.session_idle_minutes', group: 'admin', section: 'Sessions', label: 'Sign out after idle', type: 'int', default: 60, min: 5, max: 720, unit: 'min', applies: 'live', apps: A, ownerOnly: true },
  { key: 'admin.session_max_hours', group: 'admin', section: 'Sessions', label: 'Longest session', type: 'int', default: 12, min: 1, max: 72, unit: 'h', applies: 'live', apps: A, ownerOnly: true },
  { key: 'admin.code_recency_minutes', group: 'admin', section: 'Sessions', label: 'Ask for a fresh two-step code after', type: 'int', default: 15, min: 1, max: 240, unit: 'min', applies: 'live', apps: A, ownerOnly: true, help: 'Before sensitive actions.' },
  { key: 'admin.delete_hold_days', group: 'admin', section: 'Workspaces', label: 'Hold a deleted workspace for', type: 'int', default: 30, min: 1, max: 365, unit: 'days', applies: 'live', apps: A, ownerOnly: true },
];

export const SETTINGS: SettingDef[] = [
  ...CORE_SETTINGS,
  ...WHATSAPP_SETTINGS,
  ...EMAIL_SWITCH_SETTINGS,
  ...WHATSAPP_SWITCH_SETTINGS,
  ...COPY_SETTINGS,
  ...AI_STEP_SETTINGS,
];

export const SETTINGS_BY_KEY: Record<string, SettingDef> = Object.fromEntries(SETTINGS.map((d) => [d.key, d]));

/** Keys the runtime apps record their effective values under; never edited. */
export const RUNTIME_SNAPSHOT_PREFIX = '_runtime.';

/** A secret as stored: sealed ciphertext plus the last four characters as a hint. */
export interface StoredSecret {
  sealed: string;
  last4: string;
}

export function isStoredSecret(value: unknown): value is StoredSecret {
  return Boolean(value && typeof value === 'object' && typeof (value as StoredSecret).sealed === 'string');
}

export type ValidationResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Check and normalise one value from the admin form. Secrets are validated as
 * plain text here; sealing happens in the caller, which holds the key.
 */
export function validateSettingValue(def: SettingDef, raw: unknown): ValidationResult {
  const fail = (error: string): ValidationResult => ({ ok: false, error: `${def.label}: ${error}` });

  switch (def.type) {
    case 'bool':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : fail('choose on or off.');

    case 'int':
    case 'decimal': {
      const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
      if (raw === '' || raw === null || !Number.isFinite(n)) return fail('enter a number.');
      if (def.type === 'int' && !Number.isInteger(n)) return fail('enter a whole number.');
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        return fail(`between ${def.min} and ${def.max}.`);
      }
      return { ok: true, value: def.type === 'decimal' ? Math.round(n * 1000) / 1000 : n };
    }

    case 'select': {
      const v = String(raw ?? '');
      return def.options?.some((o) => o.value === v) ? { ok: true, value: v } : fail('choose one of the options.');
    }

    case 'text':
    case 'textarea':
    case 'secret': {
      if (typeof raw !== 'string') return fail('enter text.');
      const v = def.type === 'textarea' ? raw.replace(/\r\n/g, '\n').trim() : raw.trim();
      if (def.type === 'secret' && !v) return fail('enter the key.');
      const max = def.maxLength ?? (def.type === 'secret' ? 4000 : 2000);
      if (v.length > max) return fail(`at most ${max} characters.`);
      if (/[\u0000]/.test(v)) return fail('contains an invalid character.');
      if (def.requires && v && !new RegExp(def.requires.pattern, 'i').test(v)) return fail(def.requires.message);
      return { ok: true, value: v };
    }

    case 'list': {
      const items = Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n|,/);
      const clean = items.map((i) => String(i).trim()).filter(Boolean);
      const max = def.maxLength ?? 200;
      const tooLong = clean.find((i) => i.length > max);
      if (tooLong) return fail(`each entry at most ${max} characters.`);
      if (clean.length > 500) return fail('at most 500 entries.');
      return { ok: true, value: Array.from(new Set(clean)) };
    }
  }
}

/** How a value is written into an environment variable for code that reads process.env. */
export function settingToEnvString(def: SettingDef, value: unknown): string {
  if (def.type === 'list') return (value as string[]).join(',');
  if (def.key === 'email.poll_interval_minutes') return String(Number(value) * 60_000);
  return String(value);
}

/** The inverse, for showing what a server's .env currently says. */
export function settingFromEnvString(def: SettingDef, raw: string): unknown {
  switch (def.type) {
    case 'bool':
      if (def.env === 'VERIFY_CALLER_EMAIL' || def.env === 'PLIVO_VERIFY_SIGNATURE') return raw !== 'false';
      return ['true', 'on', '1', 'yes'].includes(raw.trim().toLowerCase());
    case 'int':
    case 'decimal': {
      const n = Number(raw);
      if (def.key === 'email.poll_interval_minutes') return Math.round(n / 60_000);
      return Number.isFinite(n) ? n : def.default;
    }
    case 'list':
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    default:
      return raw;
  }
}
