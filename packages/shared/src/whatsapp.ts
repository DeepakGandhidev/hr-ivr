import { WHATSAPP_KINDS_BY_KEY, whatsappKindSettingKey, whatsappTemplateSettingKey } from './whatsappKinds.js';
import { setting, settingText } from './settingsRuntime.js';

/**
 * WhatsApp through Meta's WhatsApp Cloud API (the Graph API), the only way
 * Pratibha sends WhatsApp messages.
 *
 * A business may only open a conversation with a template Meta has approved,
 * so everything here sends a template: its name and body variables, nothing
 * free-form. The connection (phone number ID and a permanent token) is set on
 * the admin panel's WhatsApp page, which checks it with Meta before saving.
 *
 * Used by the portal, the worker and the admin panel alike, through
 * `deliverWhatsApp`, which mirrors the mailer: switch, opt-out list, dedupe,
 * a log row with Meta's answer, and never a throw.
 */

const GRAPH = 'https://graph.facebook.com';
const TIMEOUT_MS = 15_000;
/** Meta caps a body variable well above this; a longer one is a bug upstream. */
const MAX_PARAM = 900;

export interface WhatsAppConfig {
  phoneNumberId: string;
  wabaId: string;
  token: string;
  appSecret: string | null;
  verifyToken: string;
  apiVersion: string;
  language: string;
}

/** The connection, when the phone number ID and token are both set; otherwise null. */
export function whatsappConfig(): WhatsAppConfig | null {
  const phoneNumberId = String(setting<string>('whatsapp.phone_number_id') ?? '').trim();
  const token = setting<string | null>('integrations.whatsapp_token');
  if (!phoneNumberId || !token) return null;
  return {
    phoneNumberId,
    wabaId: String(setting<string>('whatsapp.waba_id') ?? '').trim(),
    token,
    appSecret: setting<string | null>('integrations.whatsapp_app_secret') || null,
    verifyToken: String(setting<string>('whatsapp.verify_token') ?? ''),
    apiVersion: settingText('whatsapp.api_version', 'v23.0').trim(),
    language: settingText('whatsapp.language', 'en').trim(),
  };
}

/** "+91 98765-43210" → "919876543210": the Cloud API wants digits only. */
export function toWhatsAppNumber(e164: string): string {
  return String(e164 ?? '').replace(/\D/g, '');
}

/**
 * One body variable as Meta accepts it: no newlines or tabs, no run of four
 * or more spaces (both are refused with error 132018), never empty, and
 * capped so a runaway value cannot fail the whole message.
 */
export function cleanParam(value: unknown): string {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, ' ')
    .trim();
  if (!text) return '-';
  return text.length > MAX_PARAM ? `${text.slice(0, MAX_PARAM - 1)}…` : text;
}

interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
}

/** Meta's error body as one sentence: its message, the detail it adds, and the code. */
export function graphErrorMessage(body: unknown, httpStatus?: number): string {
  const error = (body as { error?: GraphError } | null)?.error;
  if (!error?.message) return `Meta answered HTTP ${httpStatus ?? '?'} with no explanation`;
  const details = error.error_data?.details?.trim();
  const code = error.code !== undefined ? ` (code ${error.code}${error.error_subcode ? `/${error.error_subcode}` : ''})` : '';
  return `${error.message}${details && details !== error.message ? `: ${details}` : ''}${code}`;
}

export interface GraphResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** One Graph API call with a token. Never throws; a timeout is an error like any other. */
export async function graphRequest<T = unknown>(
  path: string,
  token: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; apiVersion?: string; timeoutMs?: number } = {}
): Promise<GraphResult<T>> {
  const version = init.apiVersion ?? settingText('whatsapp.api_version', 'v23.0').trim();
  const timeoutMs = init.timeoutMs ?? TIMEOUT_MS;
  try {
    const res = await fetch(`${GRAPH}/${version}/${path.replace(/^\/+/, '')}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || (body as { error?: unknown } | null)?.error) return { ok: false, error: graphErrorMessage(body, res.status) };
    return { ok: true, data: body as T };
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, error: `Meta did not answer within ${Math.round(timeoutMs / 1000)} seconds` };
    return { ok: false, error: `Could not reach Meta: ${(err as Error)?.message ?? 'network error'}` };
  }
}

export interface TemplateMessage {
  /** Digits only, or E.164 (the + is dropped). */
  to: string;
  template: string;
  language: string;
  /** Body variables, in order: {{1}}, {{2}}, … */
  params: string[];
}

export interface SendResult {
  ok: boolean;
  /** Meta's message id, which its status webhooks refer to. */
  wamid?: string;
  error?: string;
}

/** Send one approved template through the connected number. */
export async function sendTemplate(message: TemplateMessage, config: WhatsAppConfig | null = whatsappConfig()): Promise<SendResult> {
  if (!config) return { ok: false, error: 'WhatsApp is not connected' };
  const params = message.params.map(cleanParam);
  const result = await graphRequest<{ messages?: { id?: string }[] }>(`${config.phoneNumberId}/messages`, config.token, {
    method: 'POST',
    apiVersion: config.apiVersion,
    body: {
      messaging_product: 'whatsapp',
      to: toWhatsAppNumber(message.to),
      type: 'template',
      template: {
        name: message.template,
        language: { code: message.language },
        // A template without variables (Meta's hello_world) takes no
        // components; an empty parameter list is refused as a mismatch.
        ...(params.length ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } : {}),
      },
    },
  });
  if (!result.ok) return { ok: false, error: result.error };
  const wamid = result.data?.messages?.[0]?.id;
  return wamid ? { ok: true, wamid } : { ok: false, error: 'Meta accepted the request but returned no message id' };
}

// ------------------------------------------------------------------ delivery

/** The part of a Prisma client this needs; every app passes its own. */
export interface WhatsAppDb {
  whatsappLog: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  whatsappOptout: {
    findUnique(args: { where: { phoneE164: string } }): Promise<unknown | null>;
  };
}

export interface OutgoingWhatsApp {
  /** One of WHATSAPP_KINDS. */
  kind: string;
  /** E.164, e.g. +919876543210. */
  to: string;
  /** Body variables in the kind's order. */
  params: string[];
  tenantId?: string | null;
  /** Send at most once per key (e.g. `wa_report_ready:<call>:<user>`). */
  dedupeKey?: string;
  /**
   * Send another kind's template (its name, language and value count) while
   * logging and switching this one as `kind`: the admin panel's test uses it
   * to try a real template without it counting as, say, an interview invite.
   */
  templateOf?: string;
}

export type WhatsAppStatus = 'sent' | 'failed' | 'skipped' | 'duplicate';

export interface WhatsAppDelivery {
  ok: boolean;
  status: WhatsAppStatus;
  error?: string;
  wamid?: string;
}

/** Whether the admin panel lets this kind go out. Required kinds always do. */
export function whatsappKindEnabled(kind: string): boolean {
  if (WHATSAPP_KINDS_BY_KEY[kind]?.required) return true;
  try {
    return setting<boolean>(whatsappKindSettingKey(kind)) !== false;
  } catch {
    // A kind not in the catalogue has no switch.
    return true;
  }
}

/** The template name and language a kind goes out with. */
export function templateFor(kind: string): { name: string; language: string } {
  const def = WHATSAPP_KINDS_BY_KEY[kind];
  let name = def?.template ?? kind;
  if (def && !def.required) name = settingText(whatsappTemplateSettingKey(kind), def.template).trim();
  return { name, language: def?.language ?? settingText('whatsapp.language', 'en').trim() };
}

/** "+91 98765 43210" or "919876543210" → "+919876543210", the form opt-outs are stored in. */
export function e164(phone: string): string {
  return `+${toWhatsAppNumber(phone)}`;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002';
}

/**
 * Send one WhatsApp template message, the only way Pratibha sends one:
 *   1. a kind switched off in the admin panel is not sent (and is logged as such);
 *   2. a number that replied STOP is not sent to (logged as skipped);
 *   3. a `dedupeKey` already in the log means it was sent before: not again;
 *   4. it goes out through the number connected on the admin panel's WhatsApp page;
 *   5. every attempt lands in whatsapp_log, with Meta's message id or refusal.
 *
 * Never throws: every caller is a notification beside some more important
 * action, which a WhatsApp fault must not touch.
 */
export async function deliverWhatsApp(db: WhatsAppDb, message: OutgoingWhatsApp): Promise<WhatsAppDelivery> {
  try {
    const to = e164(message.to);
    const source = message.templateOf ?? message.kind;
    const { name: template, language } = templateFor(source);
    const base = { kind: message.kind, tenantId: message.tenantId ?? null, toPhone: to, template };

    if (toWhatsAppNumber(to).length < 8) {
      await db.whatsappLog.create({ data: { ...base, status: 'failed', error: 'Not a phone number' } }).catch(() => {});
      return { ok: false, status: 'failed', error: `"${message.to}" is not a phone number` };
    }

    if (!whatsappKindEnabled(message.kind)) {
      await db.whatsappLog.create({ data: { ...base, status: 'skipped', error: 'Switched off in the admin panel' } }).catch(() => {});
      return { ok: false, status: 'skipped', error: 'This WhatsApp message is switched off in the admin panel' };
    }

    if (await db.whatsappOptout.findUnique({ where: { phoneE164: to } })) {
      await db.whatsappLog.create({ data: { ...base, status: 'skipped', error: 'opted out' } }).catch(() => {});
      return { ok: false, status: 'skipped', error: 'This number replied STOP' };
    }

    // Claim the dedupe key before sending, so two processes racing on the
    // same event cannot both send it.
    let logId: string | null = null;
    try {
      logId = (await db.whatsappLog.create({ data: { ...base, status: 'sending', ...(message.dedupeKey ? { dedupeKey: message.dedupeKey } : {}) } })).id;
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: true, status: 'duplicate' };
      // The log is a record, not a gate: a logging fault must not stop a message.
      console.error('[whatsapp] could not write the log', (err as Error).message);
    }

    const finish = async (data: Record<string, unknown>) => {
      if (logId) await db.whatsappLog.update({ where: { id: logId }, data }).catch(() => {});
    };

    // A template filled with the wrong number of values is refused by Meta
    // after a round trip; catching it here gives a clearer reason.
    const expected = WHATSAPP_KINDS_BY_KEY[source]?.vars.length;
    if (expected !== undefined && message.params.length !== expected) {
      const error = `Expected ${expected} values for ${template}, got ${message.params.length}`;
      await finish({ status: 'failed', error });
      return { ok: false, status: 'failed', error };
    }

    const config = whatsappConfig();
    if (!config) {
      console.log(`[whatsapp not sent: not connected] ${message.kind} → ${to}`);
      await finish({ status: 'failed', error: 'WhatsApp not connected (admin panel → WhatsApp)' });
      return { ok: false, status: 'failed', error: 'WhatsApp is not connected yet. Connect it on the admin panel’s WhatsApp page.' };
    }

    const result = await sendTemplate({ to, template, language, params: message.params }, config);
    if (result.ok) {
      await finish({ status: 'sent', sentAt: new Date(), wamid: result.wamid });
      return { ok: true, status: 'sent', wamid: result.wamid };
    }
    console.error(`[whatsapp] ${message.kind} to ${to} failed:`, result.error);
    await finish({ status: 'failed', error: result.error?.slice(0, 500) ?? 'Send failed' });
    return { ok: false, status: 'failed', error: result.error };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'WhatsApp send failed';
    console.error(`[whatsapp] ${message.kind} failed:`, error);
    return { ok: false, status: 'failed', error };
  }
}
