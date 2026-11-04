/**
 * Every WhatsApp message Pratibha sends, in one list.
 *
 * WhatsApp only lets a business start a conversation with a template Meta has
 * approved, so each kind is one template: its name (overridable in the admin
 * panel as `whatsapp.template.<key>`), the body text to submit to Meta, and
 * the ORDERED values the code fills into {{1}}, {{2}}, … The admin panel's
 * WhatsApp page shows this list next to the templates Meta actually holds,
 * and each kind has an on/off switch (`whatsapp.send.<key>`).
 *
 * Meta refuses a body that starts or ends with a variable, which is why every
 * body below closes with a few plain words. Plain data, safe for browser
 * bundles.
 */

export type WhatsAppKindGroup = 'team' | 'candidates' | 'admin';

export interface WhatsAppKind {
  key: string;
  group: WhatsAppKindGroup;
  label: string;
  to: string;
  when: string;
  /** Template name Meta knows it by, unless the admin panel says otherwise. */
  template: string;
  /** Fixed language for templates Pratibha does not author (Meta's sample). */
  language?: string;
  /** What fills {{1}}, {{2}}, … in order. */
  vars: string[];
  /** The body to submit to Meta (category Utility). Empty for Meta's sample. */
  body: string;
  required?: boolean;
}

export const WHATSAPP_KIND_GROUPS: { id: WhatsAppKindGroup; label: string }[] = [
  { id: 'team', label: 'Alerts to the hiring team' },
  { id: 'candidates', label: 'Messages to candidates' },
  { id: 'admin', label: 'Sent by the admin panel' },
];

export const WHATSAPP_KINDS: WhatsAppKind[] = [
  {
    key: 'candidate_invite',
    group: 'candidates',
    label: 'Interview invite',
    to: 'Candidate (with a phone number)',
    when: 'A recruiter clicks Send invites on a shortlist, alongside the email',
    template: 'pratibha_interview_invite',
    vars: ['Candidate name', 'Job title', 'Company', 'Interview phone number', 'Reference code'],
    body:
      'Hi {{1}}, thank you for applying for the {{2}} role at {{3}}. You are invited to a short phone interview with Pratibha, our AI interviewer. Please call {{4}} from this number whenever it suits you and quote reference {{5}} if asked. Good luck!',
  },
  {
    key: 'shortlist_ready',
    group: 'team',
    label: 'Candidate suggested for the shortlist',
    to: 'Owners and admins who turned on WhatsApp alerts',
    when: 'A screened CV scores above the threshold',
    template: 'pratibha_shortlist_ready',
    vars: ['Job title', 'Company', 'Candidate name', 'Score', 'Profile link'],
    body: 'New candidate for {{1}} at {{2}}: {{3}} scored {{4}} in CV screening. Open their profile at {{5}} to review. - Pratibha',
  },
  {
    key: 'report_ready',
    group: 'team',
    label: 'Interview report ready',
    to: 'Owners and admins who turned on WhatsApp alerts',
    when: 'A phone interview finishes and its report is written',
    template: 'pratibha_report_ready',
    vars: ['Candidate name', 'Job title', 'Company', 'Overall score', 'Report link'],
    body:
      'The phone interview with {{1}} for {{2}} at {{3}} is complete, overall score {{4}}. Read the full report at {{5}} when you are ready. - Pratibha',
  },
  {
    key: 'quota_warning',
    group: 'team',
    label: 'Interview minutes running low',
    to: 'Owners and admins who turned on WhatsApp alerts',
    when: 'Usage passes the warning level, and again when minutes run out',
    template: 'pratibha_minutes_low',
    vars: ['Company', 'Minutes used', 'Minutes allowed', 'Subscription link'],
    // "Minutes update:" because a body may not open on {{1}}.
    body:
      'Minutes update: {{1}} has used {{2}} of its {{3}} interview minutes this month. Add minutes or change plan at {{4}} to keep interviews running. - Pratibha',
  },
  {
    key: 'test',
    group: 'admin',
    label: 'Test message',
    to: 'The number you type',
    when: 'You click Send test on the WhatsApp page',
    // Meta's own sample, present in every business account and approved.
    template: 'hello_world',
    language: 'en_US',
    vars: [],
    body: '',
    required: true,
  },
];

export const WHATSAPP_KINDS_BY_KEY: Record<string, WhatsAppKind> = Object.fromEntries(WHATSAPP_KINDS.map((k) => [k.key, k]));

export const whatsappKindSettingKey = (kind: string) => `whatsapp.send.${kind}`;
export const whatsappTemplateSettingKey = (kind: string) => `whatsapp.template.${kind}`;
