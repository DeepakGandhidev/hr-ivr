import type { SettingDef } from '../settingsRegistry.js';
import { EMAIL_KINDS, emailKindSettingKey } from '../emailKinds.js';

/** One on/off switch per email Pratibha sends (not for the ones sign-in depends on). */
export const EMAIL_SWITCH_SETTINGS: SettingDef[] = EMAIL_KINDS.filter((k) => !k.required).map((k) => ({
  key: emailKindSettingKey(k.key),
  group: 'messages',
  section: 'Which emails are sent',
  label: k.label,
  help: `To: ${k.to}. When: ${k.when}.`,
  type: 'bool',
  default: true,
  applies: 'live',
  apps: ['web', 'worker', 'admin'],
}));
