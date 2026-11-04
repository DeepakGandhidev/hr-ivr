import type { SettingDef } from '../settingsRegistry.js';
import { WHATSAPP_KINDS, whatsappKindSettingKey, whatsappTemplateSettingKey } from '../whatsappKinds.js';

const SECTION = 'WhatsApp (Meta Cloud API)';

/**
 * WhatsApp through Meta's Cloud API: the connection (set on the admin panel's
 * WhatsApp page, which checks it with Meta before saving), the template each
 * message uses, and one on/off switch per message, like the email switches.
 */
export const WHATSAPP_SETTINGS: SettingDef[] = [
  { key: 'whatsapp.phone_number_id', group: 'integrations', section: SECTION, label: 'Phone number ID', type: 'text', default: '', applies: 'live', apps: ['web', 'worker', 'admin'], maxLength: 40, ownerOnly: true, help: 'From WhatsApp Manager → API Setup. Not the phone number itself.' },
  { key: 'whatsapp.waba_id', group: 'integrations', section: SECTION, label: 'WhatsApp Business Account ID', type: 'text', default: '', applies: 'live', apps: ['admin'], maxLength: 40, ownerOnly: true, help: 'Used to list the message templates Meta holds.' },
  { key: 'integrations.whatsapp_token', group: 'integrations', section: SECTION, label: 'Access token', type: 'secret', default: null, env: 'WHATSAPP_TOKEN', applies: 'live', apps: ['web', 'worker', 'admin'], help: "A system user's permanent token with whatsapp_business_messaging and whatsapp_business_management." },
  { key: 'integrations.whatsapp_app_secret', group: 'integrations', section: SECTION, label: 'App secret', type: 'secret', default: null, env: 'WHATSAPP_APP_SECRET', applies: 'live', apps: ['web', 'admin'], help: "The Meta app's secret (App settings → Basic). Proves webhook calls really come from Meta." },
  { key: 'whatsapp.verify_token', group: 'integrations', section: SECTION, label: 'Webhook verify token', type: 'text', default: '', applies: 'live', apps: ['web', 'admin'], maxLength: 200, ownerOnly: true, help: 'Pasted into Meta with the callback URL. Generated when WhatsApp is connected.' },
  { key: 'whatsapp.api_version', group: 'integrations', section: SECTION, label: 'Graph API version', type: 'text', default: 'v23.0', applies: 'live', apps: ['web', 'worker', 'admin'], maxLength: 10, ownerOnly: true, requires: { pattern: '^v\\d+\\.\\d+$', message: 'must look like v23.0.' } },
  { key: 'whatsapp.language', group: 'integrations', section: SECTION, label: 'Template language', type: 'text', default: 'en', applies: 'live', apps: ['web', 'worker', 'admin'], maxLength: 10, help: "The language code the templates were approved in, e.g. en or en_US." },
  { key: 'whatsapp.candidates_need_opt_in', group: 'integrations', section: SECTION, label: 'Only message candidates who opted in', type: 'bool', default: true, applies: 'live', apps: ['web', 'admin'], help: 'Off sends the interview invite to every invited candidate with a phone number. Anyone who replied STOP is never messaged.' },
  ...WHATSAPP_KINDS.filter((k) => !k.required).map(
    (k): SettingDef => ({
      key: whatsappTemplateSettingKey(k.key),
      group: 'integrations',
      section: SECTION,
      label: `Template: ${k.label}`,
      help: `The name Meta approved it under. Variables in order: ${k.vars.join(', ')}.`,
      type: 'text',
      default: k.template,
      applies: 'live',
      apps: ['web', 'worker', 'admin'],
      maxLength: 512,
      requires: { pattern: '^[a-z0-9_]+$', message: 'lowercase letters, digits and underscores only, as Meta names templates.' },
    })
  ),
];

/** One on/off switch per WhatsApp message (not the admin panel's test). */
export const WHATSAPP_SWITCH_SETTINGS: SettingDef[] = WHATSAPP_KINDS.filter((k) => !k.required).map((k) => ({
  key: whatsappKindSettingKey(k.key),
  group: 'messages',
  section: 'Which WhatsApp messages are sent',
  label: k.label,
  help: `To: ${k.to}. When: ${k.when}.`,
  type: 'bool',
  default: true,
  applies: 'live',
  apps: ['web', 'worker', 'admin'],
}));
