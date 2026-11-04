import { openSecret } from './crypto.js';
import {
  isStoredSecret,
  RUNTIME_SNAPSHOT_PREFIX,
  SETTINGS,
  SETTINGS_BY_KEY,
  settingFromEnvString,
  settingToEnvString,
  validateSettingValue,
  type SettingApp,
  type SettingDef,
} from './settingsRegistry.js';

/**
 * Platform settings at runtime, for the portal and the worker.
 *
 * One in-memory copy per process, refreshed from platform_settings every 30
 * seconds, so reading a setting is a synchronous map lookup that is safe on a
 * live call's hot path.
 *
 * Settings that used to be environment variables are also written back into
 * process.env (and restored when the admin value is cleared). Code that reads
 * process.env at the moment it needs a value therefore follows the admin panel
 * with no change, and code that has moved to `setting()` reads the same thing.
 */

export interface SettingRow {
  key: string;
  value: unknown;
}

export interface SettingsRuntimeOptions {
  app: SettingApp;
  load: () => Promise<SettingRow[]>;
  /** Persist what this process is actually running with, for the admin panel. */
  saveReport?: (app: SettingApp, values: Record<string, unknown>) => Promise<void>;
  intervalMs?: number;
  logger?: { warn?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
}

interface RuntimeState {
  app: SettingApp | null;
  saved: Map<string, unknown>;
  baseEnv: Record<string, string | undefined> | null;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<() => void>;
  lastSnapshot: string;
  options: SettingsRuntimeOptions | null;
}

// On globalThis because Next.js can load this module more than once (one copy
// per server bundle); they must all share one cache and one timer.
const g = globalThis as unknown as { __pratibhaSettings?: RuntimeState };
const state: RuntimeState = (g.__pratibhaSettings ??= {
  app: null,
  saved: new Map(),
  baseEnv: null,
  timer: null,
  listeners: new Set(),
  lastSnapshot: '',
  options: null,
});

function captureBaseEnv() {
  if (state.baseEnv) return;
  state.baseEnv = {};
  for (const def of SETTINGS) {
    if (def.env) state.baseEnv[def.env] = process.env[def.env];
  }
}

/** What the server's own environment says, ignoring anything the panel saved. */
function envValue(def: SettingDef): unknown {
  if (!def.env) return undefined;
  const raw = state.baseEnv ? state.baseEnv[def.env] : process.env[def.env];
  if (raw === undefined || raw === '') return undefined;
  return settingFromEnvString(def, raw);
}

/**
 * The effective value of a setting: saved in the admin panel, else the
 * server's environment, else the registry default. Secrets come back as
 * plain text (or null when none is configured anywhere).
 */
export function setting<T = unknown>(key: string): T {
  const def = SETTINGS_BY_KEY[key];
  if (!def) throw new Error(`Unknown setting ${key}`);
  if (state.saved.has(key)) return state.saved.get(key) as T;
  const fromEnv = envValue(def);
  return (fromEnv !== undefined ? fromEnv : def.default) as T;
}

/** Text settings where empty means "use the built-in wording". */
export function settingText(key: string, fallback: string): string {
  const v = setting<string>(key);
  return typeof v === 'string' && v.trim() ? v : fallback;
}

/** Where the effective value came from, for the admin panel's snapshot. */
export function settingSource(key: string): 'panel' | 'env' | 'default' {
  const def = SETTINGS_BY_KEY[key];
  if (state.saved.has(key)) return 'panel';
  return def && envValue(def) !== undefined ? 'env' : 'default';
}

/** Call `fn` whenever a refresh changed any value. Returns an unsubscribe. */
export function onSettingsChange(fn: () => void): () => void {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

function parseRow(def: SettingDef, value: unknown, logger?: SettingsRuntimeOptions['logger']): { ok: boolean; value?: unknown } {
  if (def.type === 'secret') {
    if (!isStoredSecret(value)) return { ok: false };
    try {
      return { ok: true, value: openSecret(value.sealed) };
    } catch (err) {
      // A key sealed with a different EMAIL_SECRET_KEY: fall back to .env
      // rather than handing a provider garbage.
      logger?.warn?.({ key: def.key, err: (err as Error).message }, 'Saved secret could not be opened; using the server value');
      return { ok: false };
    }
  }
  const checked = validateSettingValue(def, value);
  if (!checked.ok) {
    logger?.warn?.({ key: def.key, err: checked.error }, 'Saved setting is invalid; using the server value');
    return { ok: false };
  }
  return { ok: true, value: checked.value };
}

function applyEnv(app: SettingApp) {
  for (const def of SETTINGS) {
    if (!def.env || !def.apps.includes(app)) continue;
    if (state.saved.has(def.key)) {
      process.env[def.env] = settingToEnvString(def, state.saved.get(def.key));
    } else {
      const base = state.baseEnv?.[def.env];
      if (base === undefined) delete process.env[def.env];
      else process.env[def.env] = base;
    }
  }
}

function snapshot(app: SettingApp) {
  const values: Record<string, unknown> = {};
  for (const def of SETTINGS) {
    if (!def.apps.includes(app)) continue;
    const v = setting(def.key);
    values[def.key] = {
      source: settingSource(def.key),
      value: def.type === 'secret' ? (v ? { set: true, last4: String(v).slice(-4) } : { set: false }) : v,
    };
  }
  return values;
}

/** Load once now. Exposed for tests and for an immediate refresh after a save. */
export async function refreshSettings(): Promise<boolean> {
  const options = state.options;
  if (!options) return false;
  const rows = await options.load();

  const next = new Map<string, unknown>();
  for (const row of rows) {
    if (row.key.startsWith(RUNTIME_SNAPSHOT_PREFIX)) continue;
    const def = SETTINGS_BY_KEY[row.key];
    if (!def) continue;
    const parsed = parseRow(def, row.value, options.logger);
    if (parsed.ok) next.set(def.key, parsed.value);
  }

  const before = JSON.stringify([...state.saved]);
  state.saved = next;
  applyEnv(options.app);
  const changed = before !== JSON.stringify([...next]);

  if (changed) {
    for (const fn of state.listeners) {
      try {
        fn();
      } catch (err) {
        options.logger?.warn?.({ err: (err as Error).message }, 'Settings listener failed');
      }
    }
  }

  if (options.saveReport) {
    const snap = snapshot(options.app);
    const json = JSON.stringify(snap);
    if (json !== state.lastSnapshot) {
      await options
        .saveReport(options.app, snap)
        .then(() => {
          state.lastSnapshot = json;
        })
        .catch((err) => options.logger?.warn?.({ err: (err as Error).message }, 'Could not record the settings report'));
    }
  }
  return changed;
}

/**
 * Start the refresh loop. Resolves after the first load (or its failure), so
 * a caller that awaits it starts with the admin panel's values in place.
 */
export async function startSettings(options: SettingsRuntimeOptions): Promise<void> {
  captureBaseEnv();
  state.options = options;
  state.app = options.app;

  await refreshSettings().catch((err) =>
    options.logger?.warn?.({ err: (err as Error).message }, 'Could not load platform settings; using server defaults')
  );

  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    refreshSettings().catch((err) =>
      options.logger?.warn?.({ err: (err as Error).message }, 'Platform settings refresh failed; keeping the last values')
    );
  }, options.intervalMs ?? 30_000);
  state.timer.unref?.();
}

/** For tests: forget everything and restore the environment. */
export function __resetSettingsRuntime() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.saved = new Map();
  if (state.baseEnv) {
    for (const [k, v] of Object.entries(state.baseEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  state.baseEnv = null;
  state.options = null;
  state.lastSnapshot = '';
  state.listeners.clear();
}
