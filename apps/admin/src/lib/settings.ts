import {
  isStoredSecret,
  SETTINGS,
  SETTINGS_BY_KEY,
  settingFromEnvString,
  validateSettingValue,
} from "@pratibha/shared/settings-registry";
import { db, type Db } from "@/lib/db";

/**
 * Platform settings, as the admin panel reads them.
 *
 * Every key, its type and its default live in the shared registry
 * (packages/shared/src/settingsRegistry.ts); the portal and the worker read
 * the same rows. The effective value is: saved here, else this server's
 * environment variable, else the registry default. A saved value that no
 * longer passes validation is ignored rather than trusted.
 *
 * Secrets never leave this module as plain text: they come back as
 * { set, last4 }.
 */

export type SettingKey = string;

export const SETTING_DEFAULTS: Record<string, unknown> = Object.fromEntries(SETTINGS.map((d) => [d.key, d.default]));

/** Which plans a gated feature is open to. */
export const GATE_OPTIONS = [
  { value: "all", label: "Every plan" },
  { value: "growth", label: "Growth and above" },
  { value: "scale", label: "Scale only" },
] as const;

export interface SecretHint {
  set: boolean;
  last4?: string;
}

function fromRow(key: string, value: unknown): { ok: true; value: unknown } | { ok: false } {
  const def = SETTINGS_BY_KEY[key];
  if (!def) return { ok: false };
  if (def.type === "secret") {
    return isStoredSecret(value) ? { ok: true, value: { set: true, last4: value.last4 } satisfies SecretHint } : { ok: false };
  }
  const checked = validateSettingValue(def, value);
  return checked.ok ? { ok: true, value: checked.value } : { ok: false };
}

function fallback(key: string): unknown {
  const def = SETTINGS_BY_KEY[key];
  if (!def) return undefined;
  const raw = def.env ? process.env[def.env] : undefined;
  if (raw !== undefined && raw !== "") {
    return def.type === "secret" ? ({ set: true, last4: raw.slice(-4) } satisfies SecretHint) : settingFromEnvString(def, raw);
  }
  return def.type === "secret" ? ({ set: false } satisfies SecretHint) : def.default;
}

export async function getSetting(key: SettingKey, client: Db = db): Promise<any> {
  const row = await client.platformSetting.findUnique({ where: { key } });
  if (row) {
    const parsed = fromRow(key, row.value);
    if (parsed.ok) return parsed.value;
  }
  return fallback(key);
}

export async function getSettings(client: Db = db): Promise<Record<string, any>> {
  const rows = await client.platformSetting.findMany();
  const out: Record<string, unknown> = {};
  for (const def of SETTINGS) out[def.key] = fallback(def.key);
  for (const row of rows) {
    const parsed = fromRow(row.key, row.value);
    if (parsed.ok) out[row.key] = parsed.value;
  }
  return out;
}

/** Keys that have a saved value in the panel (as opposed to .env or default). */
export async function savedSettingKeys(client: Db = db): Promise<Set<string>> {
  const rows = await client.platformSetting.findMany({ select: { key: true, value: true } });
  return new Set(rows.filter((r) => fromRow(r.key, r.value).ok).map((r) => r.key));
}

export interface RuntimeSnapshot {
  at: string;
  values: Record<string, { source: "panel" | "env" | "default"; value: unknown }>;
}

/** What the portal and the worker last reported running with. */
export async function runtimeSnapshots(client: Db = db): Promise<Partial<Record<"web" | "worker", RuntimeSnapshot>>> {
  const rows = await client.appRuntimeReport.findMany().catch(() => []);
  const out: Partial<Record<"web" | "worker", RuntimeSnapshot>> = {};
  for (const row of rows) {
    if (row.app === "web" || row.app === "worker") {
      out[row.app] = { at: row.reportedAt.toISOString(), values: row.values as RuntimeSnapshot["values"] };
    }
  }
  return out;
}
