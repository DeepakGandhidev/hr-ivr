import type { SettingDef } from '../settingsRegistry.js';
import { SUPPORTED_LANGUAGES } from '../constants.js';

/**
 * The AI's own step-by-step instructions on a call (group 'ai_steps'): what
 * it is told to do at each stage and after each tool result. Defaults are the
 * shipped instructions.
 *
 * The worker reads each one at the moment it hands it to the model, and fills
 * {placeholders} from the call. Only the placeholders a setting's help lists
 * are filled; any other {word} is passed on as typed. An emptied value goes
 * back to the default, so a step can never be blanked out.
 */

const S_CONFIRM = 'Identity: number recognised (confirm_email)';
const S_PROVIDE = 'Identity: number not recognised (provide_email)';
const S_IDENTITY = 'Identity: either check';
const S_CONSENT = 'Language and consent (select_language, record_time_consent, record_recording_consent)';
const S_SCREEN = 'Screening questions (record_detail, finish_screening)';
const S_STAGE = 'Stage guidance (system prompt)';
const S_LANG = 'Languages offered';
const S_TOOLS = 'Tool descriptions';

const LANGS = '{languages} is the offered languages, read out (e.g. "English, Hindi, or Hinglish").';
const RESULT = 'Sent to the AI in the tool result, as its instruction for what to say next,';
const STAGE = 'Added to the system prompt under WHAT THIS TURN IS FOR on every turn';
const TOOL =
  'Sent to the AI as this tool\'s description on every turn where the tool is available. Changing this changes when the AI calls the tool. Only the description is editable; the tool\'s name and inputs are fixed.';

function step(key: string, section: string, label: string, text: string, help: string, maxLength = 2000): SettingDef {
  return {
    key: `ai_steps.${key}`,
    group: 'ai_steps',
    section,
    label,
    type: 'textarea',
    default: text,
    applies: 'next_call',
    apps: ['worker'],
    maxLength,
    help,
  };
}

export const AI_STEP_SETTINGS: SettingDef[] = [
  // ------------------------------------------------- identity: confirm_email
  step(
    'confirm_email.verified',
    S_CONFIRM,
    'Email confirmed',
    'Thank them by first name now that they are confirmed, then ask whether they would like to continue in {languages}. Do not greet them again or re-introduce yourself.',
    `${RESULT} when the email a recognised caller says matches their application. {name} is the candidate's name (released to the AI at this point). ${LANGS}`
  ),
  step(
    'confirm_email.no_email_on_file',
    S_CONFIRM,
    'No email on file to check against',
    'Thank them and ask whether they would like to continue in {languages}.',
    `${RESULT} when the recognised candidate has no email on their application, so the interview goes ahead unchecked. ${LANGS}`
  ),
  step(
    'confirm_email.other_candidate',
    S_CONFIRM,
    'Email belongs to a different candidate',
    'This is a different candidate to the one the number is registered to, which is fine. Greet them by first name, confirm the role you have them down for, then ask whether they would like to continue in {languages}. Do not re-introduce yourself.',
    `${RESULT} when the email belongs to another approved candidate (a borrowed or shared phone). {name} and {job_title} are that candidate's. ${LANGS}`
  ),
  step(
    'confirm_email.retry',
    S_CONFIRM,
    'Email did not match: ask again',
    'Say the line may have broken up, and ask them to say just the part of their email address before the "at" sign, slowly. Never suggest they gave the wrong address, never reveal the address on file, and never read any part of it back to them.',
    `${RESULT} after a mismatch while attempts remain. {attempts_left} is how many tries are left. Keep it from revealing the address on file.`
  ),
  step(
    'confirm_email.attempts_exhausted',
    S_CONFIRM,
    'Email did not match: no attempts left',
    'Say you were not able to confirm their details, that the team will follow up by email, thank them warmly, and end the call. Do not say what the correct address is.',
    `${RESULT} after the last allowed mismatch; the call then ends. No placeholders.`
  ),

  // ------------------------------------------------- identity: provide_email
  step(
    'provide_email.found',
    S_PROVIDE,
    'Application found',
    'Confirm their name and the role, then ask whether they would like to continue in {languages}.',
    `${RESULT} when the email an unrecognised caller gives matches an application. {name} and {job_title} are the candidate's. ${LANGS}`
  ),
  step(
    'provide_email.not_found',
    S_PROVIDE,
    'No application under that email',
    'Politely say you cannot find an application under that email address, ask them to check it and apply again if needed, thank them, and end the call.',
    `${RESULT} when the email matches no application; the call then ends. No placeholders.`
  ),
  step(
    'provide_email.paused',
    S_PROVIDE,
    'Workspace paused',
    'Say interviews for this role are paused at the moment so you cannot go ahead today, that the team will be in touch by email, thank them, and end the call. Do not say why.',
    `${RESULT} when the matched workspace is paused; the call then ends. No placeholders.`
  ),
  step(
    'provide_email.not_shortlisted',
    S_PROVIDE,
    'Not on the approved shortlist',
    'Say you found the email but the candidate is not currently on the approved shortlist. Thank them and end the call.',
    `${RESULT} when "Interview only shortlisted and approved candidates" is on and this candidate is not approved; the call then ends. No placeholders.`
  ),

  // ------------------------------------------------- identity: both
  step(
    'identity.already_interviewed',
    S_IDENTITY,
    'Already interviewed',
    'Say you already have a completed interview on file for this role, thank them, and end the call warmly.',
    `${RESULT} by either identity check when the candidate already has a completed interview; the call then ends. No placeholders.`
  ),

  // ------------------------------------------------- language and consent
  step(
    'select_language.chosen',
    S_CONSENT,
    'Language chosen',
    'Confirm the language choice, say the call takes about {minutes} minutes, and ask whether now is a good time.',
    `${RESULT} after the caller picks a language. {minutes} is this call's interview length (the job's, else the platform default). {language} is the chosen language's name.`
  ),
  step(
    'time_consent.proceed',
    S_CONSENT,
    'Now is a good time',
    'Now ask for permission to record the call so the team can review their answers properly.',
    `${RESULT} when the candidate says they can talk now. No placeholders.`
  ),
  step(
    'time_consent.withdrawn',
    S_CONSENT,
    'Candidate withdrew',
    'Thank them for letting us know and end the call warmly.',
    `${RESULT} when the candidate says they are no longer interested; the call then ends. No placeholders.`
  ),
  step(
    'recording_consent.granted',
    S_CONSENT,
    'Recording allowed',
    'Thank them and begin the screening questions.',
    `${RESULT} when the candidate allows recording; the interview clock starts. {minutes} is this call's interview length.`
  ),
  step(
    'recording_consent.declined',
    S_CONSENT,
    'Recording declined',
    'Tell them that is absolutely fine, you will not record and will take notes instead, then begin the screening questions.',
    `${RESULT} when the candidate declines recording; the interview carries on and the clock starts. {minutes} is this call's interview length.`
  ),

  // ------------------------------------------------- screening
  step(
    'record_detail.recorded',
    S_SCREEN,
    'Practical answer recorded',
    'Thank them neutrally and move on. Do not comment on the answer.',
    `${RESULT} after each practical answer (notice period, salary, location...). No placeholders.`
  ),
  step(
    'record_detail.salary_check_followup',
    S_SCREEN,
    'Salary above band: after the check line',
    'Then record their answer with field band_answer and carry on.',
    `${RESULT} alongside the salary check line from the interviewer prompt, when the expected salary is above the band and the job asks to check. Must keep telling it to record the answer with field band_answer, or the answer is lost. No placeholders.`
  ),
  step(
    'record_detail.salary_noted',
    S_SCREEN,
    'Salary above band: noted only',
    'Thank them neutrally and move on. Do not mention the band.',
    `${RESULT} when the expected salary is above the band and the job only notes it. No placeholders.`
  ),
  step(
    'finish_screening.with_questions',
    S_SCREEN,
    'Screening finished: invite questions',
    'Tell them that is everything from your side and ask whether they have any questions about the role or the company.',
    `${RESULT} when screening is finished and the job lets candidates ask questions. No placeholders.`
  ),
  step(
    'finish_screening.without_questions',
    S_SCREEN,
    'Screening finished: close',
    'Tell them that is everything from your side, close the call as your closing instructions say, and call end_call.',
    `${RESULT} when screening is finished and the job does not take candidate questions. Must keep telling it to call end_call. No placeholders.`
  ),
  step(
    'criteria.must_have_guidance',
    S_SCREEN,
    'Guidance on each must-have',
    'Must-have for this role.',
    'Shown to the AI after each must-have in the screening criteria list, in the interview prompt and the report prompt. No placeholders.',
    300
  ),
  step(
    'criteria.nice_to_have_guidance',
    S_SCREEN,
    'Guidance on each good-to-have',
    'Nice-to-have for this role.',
    'Shown to the AI after each good-to-have in the screening criteria list, in the interview prompt and the report prompt. No placeholders.',
    300
  ),

  // ------------------------------------------------- stage guidance
  step(
    'stage.identify',
    S_STAGE,
    'Unknown number: ask for email',
    'Their number is not on the shortlist. Ask which email address they applied with, then pass exactly what they say to provide_email.',
    `${STAGE} while the caller's number was not recognised (stage IDENTIFY). No placeholders.`
  ),
  step(
    'stage.verify_email',
    S_STAGE,
    'Recognised number: confirm email',
    'A greeting has been spoken and you are confirming who the caller is. Ask which email address they applied with, then pass exactly what they say to confirm_email. ' +
      'You have not been told their name and must not use one, or ask them to confirm a name. Never read the address on file aloud, never spell any part of it, and never hint at it - they must produce it. Ask once, warmly, in one sentence.',
    `${STAGE} while a recognised caller confirms their email (stage VERIFY_EMAIL). No placeholders.`
  ),
  step(
    'stage.unverified_caller',
    S_STAGE,
    'Who the caller is, before they are verified',
    'Not yet established. Their number matches someone on the shortlist, but that only identifies the phone, not the person holding it.\n' +
      'You do NOT know their name, employer, or anything on their CV, and you must not guess or imply any of it. Do not use a name at all this turn.',
    'Added to the system prompt under WHO YOU ARE SPEAKING TO while a recognised caller has not yet confirmed their email; the job title follows it. Must keep it from using or guessing a name. No placeholders.'
  ),
  step(
    'stage.language_select',
    S_STAGE,
    'Choose a language',
    'Ask which language they would like: {languages}. Then call select_language.',
    `${STAGE} in stage LANGUAGE_SELECT. ${LANGS}`
  ),
  step(
    'stage.consent_time',
    S_STAGE,
    'Ask if now is a good time',
    'Ask whether now is a good time and say the call takes about {minutes} minutes.',
    `${STAGE} in stage CONSENT_TIME. {minutes} is this call's interview length (the job's, else the platform default).`
  ),
  step(
    'stage.consent_recording',
    S_STAGE,
    'Ask to record',
    'Ask for permission to record before any interview question.',
    `${STAGE} in stage CONSENT_RECORDING. No placeholders.`
  ),
  step(
    'stage.screen_wrap_up',
    S_STAGE,
    'Screening: time or questions used up',
    'Wrap up now and call finish_screening.',
    'Appended to the screening progress line once the planned questions are asked or the time is up. Must keep telling it to call finish_screening. No placeholders.',
    500
  ),
  step(
    'stage.candidate_qa',
    S_STAGE,
    "Candidate's questions",
    'Invite any questions they have about the role or the process.',
    `${STAGE} in stage CANDIDATE_QA when the job takes candidate questions. No placeholders.`
  ),
  step(
    'stage.close_only',
    S_STAGE,
    'Close (no candidate questions)',
    'Screening is finished. Close the call now as your closing instructions say, then call end_call.',
    `${STAGE} after screening when the job does not take candidate questions. Must keep telling it to call end_call. No placeholders.`
  ),
  step(
    'stage.language_hint_en',
    S_STAGE,
    'Conduct in English',
    'Conduct this conversation in English (Indian). Use simple words because the line is noisy.',
    'Given to the interviewer prompt as its language line when the call is in English (and before a language is chosen). No placeholders.',
    500
  ),
  step(
    'stage.language_hint_hi',
    S_STAGE,
    'Conduct in Hindi',
    'Conduct this conversation in Hindi.',
    'Given to the interviewer prompt as its language line when the caller chose Hindi. No placeholders.',
    500
  ),
  step(
    'stage.language_hint_hinglish',
    S_STAGE,
    'Conduct in Hinglish',
    'Conduct this conversation in Hinglish (Hindi words in Roman script, mixed with English).',
    'Given to the interviewer prompt as its language line when the caller chose Hinglish. No placeholders.',
    500
  ),

  // ------------------------------------------------- languages
  {
    key: 'ai_steps.languages',
    group: 'ai_steps',
    section: S_LANG,
    label: 'Interview languages offered',
    type: 'list',
    default: [...SUPPORTED_LANGUAGES],
    applies: 'next_call',
    apps: ['worker'],
    maxLength: 20,
    help: `Codes, one per line: ${SUPPORTED_LANGUAGES.join(', ')} (en = English, hi = Hindi, hinglish = Hinglish). Other codes are ignored; if none is left, all are offered. Fills {languages} and limits what select_language accepts.`,
  },

  // ------------------------------------------------- tool descriptions
  step(
    'tool.provide_email',
    S_TOOLS,
    'provide_email',
    'The caller has given their email address to identify themselves. Look it up against the applications on file and continue if it matches.',
    TOOL,
    1000
  ),
  step(
    'tool.confirm_email',
    S_TOOLS,
    'confirm_email',
    'The caller was recognised by phone number. Check the email address they just said against the one on their application before the interview begins.',
    TOOL,
    1000
  ),
  step(
    'tool.select_language',
    S_TOOLS,
    'select_language',
    'Record the language the caller wants for the interview: {languages}.',
    `${TOOL} ${LANGS}`,
    1000
  ),
  step(
    'tool.record_time_consent',
    S_TOOLS,
    'record_time_consent',
    'Record whether the candidate can talk right now. Call with proceed=false if they are busy or want to call back, or with withdrawn=true if they are no longer interested in the role.',
    TOOL,
    1000
  ),
  step(
    'tool.record_recording_consent',
    S_TOOLS,
    'record_recording_consent',
    "Record the candidate's answer on recording the call. Declining is completely fine and the conversation continues either way - never end the call over it.",
    TOOL,
    1000
  ),
  step(
    'tool.record_detail',
    S_TOOLS,
    'record_detail',
    "Record the candidate's answer to one of the practical questions, in their own words. For salaries, pass the figure exactly as they said it; it is converted to an annual figure for you. Follow any instruction or say_exactly in the result.",
    TOOL,
    1000
  ),
  step(
    'tool.finish_screening',
    S_TOOLS,
    'finish_screening',
    "Call when you have covered the screening criteria and are ready to invite the candidate's own questions. List which criteria you actually reached and which you did not, with the reason.",
    TOOL,
    1000
  ),
  step(
    'tool.escalate',
    S_TOOLS,
    'escalate',
    'Flag this call for a human on the team and end it politely. Use when the candidate asks to speak to a person, becomes hostile or distressed, or the line is too poor to continue. A human will follow up by email - you must never promise a call back.',
    TOOL,
    1000
  ),
  step(
    'tool.end_call',
    S_TOOLS,
    'end_call',
    'End the call once you have closed it off. Use outcome "completed" after a normal screening.',
    TOOL,
    1000
  ),
];
