import { randomBytes } from "node:crypto";
import type { AdminUser } from "@pratibha/prisma";
import { setting } from "@pratibha/shared/settings-runtime";
import { WHATSAPP_KINDS, type WhatsAppKind } from "@pratibha/shared/whatsapp-kinds";
import { deliverWhatsApp, graphRequest, templateFor, whatsappConfig, type WhatsAppDb } from "@pratibha/shared/whatsapp";
import { badRequest } from "@/lib/http";
import { saveSettings } from "@/lib/settings-admin";
import { db } from "@/lib/db";

/**
 * The WhatsApp page: connect Pratibha's WhatsApp Business number (Meta's
 * Cloud API), see which templates Meta has approved, and send a test.
 *
 * The token is proved with Meta before anything is saved, so the panel never
 * stores a connection that cannot send. Nothing here talks to Meta except
 * through the shared client, which never throws.
 */

export interface PhoneNumberInfo {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
}

export interface MetaTemplate {
  name: string;
  status: string;
  language: string;
  category?: string;
  components?: { type: string; text?: string }[];
}

/** The number behind a phone number ID, which doubles as the check that the token can use it. */
export function fetchPhoneNumber(phoneNumberId: string, token: string, apiVersion?: string) {
  return graphRequest<PhoneNumberInfo>(
    `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
    token,
    { apiVersion, timeoutMs: 10_000 }
  );
}

/** Every template in the business account, as Meta holds them now. */
export async function fetchTemplates(wabaId: string, token: string, apiVersion?: string) {
  const result = await graphRequest<{ data?: MetaTemplate[] }>(
    `${encodeURIComponent(wabaId)}/message_templates?fields=name,status,language,category,components&limit=200`,
    token,
    { apiVersion, timeoutMs: 10_000 }
  );
  return result.ok ? { ok: true as const, templates: result.data?.data ?? [] } : { ok: false as const, error: result.error ?? "Unknown error" };
}

export type TemplateState = "APPROVED" | "PENDING" | "REJECTED" | "MISSING" | string;

export interface TemplateRow {
  key: string;
  label: string;
  group: string;
  to: string;
  when: string;
  required: boolean;
  name: string;
  language: string;
  state: TemplateState;
  vars: string[];
  body: string;
  /** Something about Meta's copy an admin should fix, e.g. a variable count that does not match. */
  problem: string | null;
}

/** {{1}}…{{n}} in a template body: how many values it takes. */
function variableCount(text: string): number {
  return new Set(Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)).map((m) => m[1])).size;
}

/**
 * Each catalogue kind next to Meta's template of that name and language.
 * `templates` is null when Meta could not be asked (then every row says so).
 */
export function templateRows(kinds: WhatsAppKind[], templates: MetaTemplate[] | null): TemplateRow[] {
  return kinds.map((kind) => {
    const { name, language } = templateFor(kind.key);
    const base = {
      key: kind.key,
      label: kind.label,
      group: kind.group,
      to: kind.to,
      when: kind.when,
      required: Boolean(kind.required),
      name,
      language,
      vars: kind.vars,
      body: kind.body,
    };
    if (!templates) return { ...base, state: "UNKNOWN", problem: null };

    const sameName = templates.filter((t) => t.name === name);
    const match = sameName.find((t) => t.language === language);
    if (!match) {
      const others = sameName.map((t) => t.language).join(", ");
      return { ...base, state: "MISSING", problem: others ? `Meta has it in ${others}, not ${language}.` : null };
    }

    const bodyText = match.components?.find((c) => c.type?.toUpperCase() === "BODY")?.text ?? "";
    const count = variableCount(bodyText);
    const problem =
      count !== kind.vars.length
        ? `Meta's version takes ${count} ${count === 1 ? "value" : "values"}; Pratibha sends ${kind.vars.length}. Every message would be refused.`
        : null;
    return { ...base, state: match.status?.toUpperCase() ?? "UNKNOWN", problem };
  });
}

/** The catalogue's rows, live from Meta when WhatsApp is connected. */
export async function loadTemplateRows(): Promise<{ rows: TemplateRow[]; error: string | null }> {
  const config = whatsappConfig();
  if (!config || !config.wabaId) return { rows: templateRows(WHATSAPP_KINDS, null), error: config ? "No WhatsApp Business Account ID is saved." : null };
  const result = await fetchTemplates(config.wabaId, config.token, config.apiVersion);
  if (!result.ok) return { rows: templateRows(WHATSAPP_KINDS, null), error: `Meta did not list the templates: ${result.error}` };
  return { rows: templateRows(WHATSAPP_KINDS, result.templates), error: null };
}

const ID = /^\d{5,30}$/;

export async function connectWhatsApp(
  admin: AdminUser,
  input: { phoneNumberId: string; wabaId: string; token: string; appSecret: string }
) {
  const phoneNumberId = input.phoneNumberId.trim();
  const wabaId = input.wabaId.trim();
  const token = input.token.trim();
  const appSecret = input.appSecret.trim();
  if (!ID.test(phoneNumberId)) throw badRequest("The phone number ID is a long number from WhatsApp Manager → API Setup, not the phone number.");
  if (!ID.test(wabaId)) throw badRequest("The WhatsApp Business Account ID is a long number from WhatsApp Manager.");
  if (!token) throw badRequest("Enter the permanent access token.");
  if (!appSecret) throw badRequest("Enter the app secret, so Pratibha can tell Meta's webhook calls from anyone else's.");

  const check = await fetchPhoneNumber(phoneNumberId, token);
  if (!check.ok) {
    throw badRequest(
      `Meta did not accept that token for phone number ID ${phoneNumberId}: ${check.error}. Check the ID, and that the token belongs to a system user with access to this number.`
    );
  }

  // Kept across reconnects, so the callback already saved in Meta stays valid.
  const verifyToken = String(setting<string>("whatsapp.verify_token") ?? "").trim() || randomBytes(24).toString("base64url");

  await saveSettings(admin, {
    set: {
      "whatsapp.phone_number_id": phoneNumberId,
      "whatsapp.waba_id": wabaId,
      "integrations.whatsapp_token": token,
      "integrations.whatsapp_app_secret": appSecret,
      "whatsapp.verify_token": verifyToken,
    },
  });

  const number = check.data?.display_phone_number ?? phoneNumberId;
  const name = check.data?.verified_name ? ` (${check.data.verified_name})` : "";
  return { message: `Connected ${number}${name}. Now paste the callback URL and verify token below into Meta, and subscribe to "messages".` };
}

/** "98765 43210" → "+919876543210"; anything with a country code is kept as typed. */
export function normaliseTestNumber(raw: string): string | null {
  const typed = raw.trim();
  const digits = typed.replace(/\D/g, "");
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if ((typed.startsWith("+") || digits.length > 10) && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** What a test fills each value with, by the catalogue's name for it. */
const SAMPLE_VALUES: Record<string, string> = {
  "Candidate name": "Asha Verma",
  "Job title": "Sales Executive",
  Company: "Pratibha Test",
  "Interview phone number": "+91 98765 43210",
  "Reference code": "TEST-1234",
  Score: "82/100",
  "Overall score": "78/100",
  "Profile link": "https://pratibha.tech",
  "Report link": "https://pratibha.tech",
  "Subscription link": "https://pratibha.tech",
  "Minutes used": "450",
  "Minutes allowed": "500",
};

export function sampleValues(kind: WhatsAppKind): string[] {
  return kind.vars.map((v) => SAMPLE_VALUES[v] ?? "Sample");
}

/**
 * Send one message's template, filled with sample values, to the number typed
 * in. Logged as a test, so it is never counted as a real invite or alert, and
 * sent even when that message is switched off. `kind` "test" is Meta's
 * hello_world, which only some business accounts have.
 */
export async function sendWhatsAppTest(phone: string, kindKey = "test") {
  const to = normaliseTestNumber(phone);
  if (!to) throw badRequest("Enter a mobile number: 10 digits for India, or with its country code.");
  const kind = WHATSAPP_KINDS.find((k) => k.key === kindKey);
  if (!kind) throw badRequest("Pick one of the templates listed on this page.");
  if (!whatsappConfig()) throw badRequest("WhatsApp is not connected yet.");
  const { name } = templateFor(kind.key);
  const result = await deliverWhatsApp(db as unknown as WhatsAppDb, {
    kind: "test",
    to,
    params: sampleValues(kind),
    ...(kind.key === "test" ? {} : { templateOf: kind.key }),
  });
  if (!result.ok) throw badRequest(`The test of ${name} failed: ${result.error ?? "unknown error"}`);
  return { message: `Meta accepted the test of ${name} for ${to}. It should arrive within a minute; its delivery shows in the log below.` };
}

export async function disconnectWhatsApp(admin: AdminUser) {
  // The verify token stays, so reconnecting needs no change in Meta.
  await saveSettings(admin, {
    reset: ["integrations.whatsapp_token", "integrations.whatsapp_app_secret", "whatsapp.phone_number_id", "whatsapp.waba_id"],
  });
  return { message: "Disconnected. Pratibha will not send WhatsApp messages until a number is connected again." };
}
