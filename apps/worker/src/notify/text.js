import { SETTINGS_BY_KEY } from '@pratibha/shared/settings-registry';
import { setting, settingText } from '@pratibha/shared/settings-runtime';

/**
 * Admin-editable wording for the emails the worker sends (Text and emails in
 * the admin panel, the copy.email.* entries marked for the worker). The same
 * rules as the portal's lib/copy.ts: the default is the shipped wording, and
 * a placeholder the code did not pass is left as written, so a typo in the
 * panel shows up in the email instead of silently vanishing.
 */

export function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

/** One piece of text, with {placeholders} filled from `vars`. */
export function copyText(key, vars) {
  const def = SETTINGS_BY_KEY[key];
  if (!def || def.group !== 'copy') throw new Error(`Unknown copy key ${key}`);
  return fill(settingText(key, String(def.default ?? '')), vars);
}

export function productName() {
  return settingText('brand.product_name', 'Pratibha');
}

/** The portal's public URL for links in email, without a trailing slash. */
export function portalUrl() {
  return String(setting('brand.app_url') ?? '').replace(/\/+$/, '');
}
