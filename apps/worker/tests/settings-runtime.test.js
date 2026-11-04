import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.EMAIL_SECRET_KEY ??= 'a'.repeat(64);

const { sealSecret } = await import('@pratibha/shared/crypto');
const { SETTINGS, validateSettingValue } = await import('@pratibha/shared/settings-registry');
const { setting, settingText, startSettings, refreshSettings, onSettingsChange, __resetSettingsRuntime } = await import(
  '@pratibha/shared/settings-runtime'
);

const quiet = { warn: () => {}, info: () => {} };

describe('settings registry', () => {
  it('has unique keys, and every default passes its own validation', () => {
    const keys = SETTINGS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of SETTINGS) {
      if (def.type === 'secret') continue;
      const v = validateSettingValue(def, def.default);
      // Empty text is a legitimate default ("use the built-in wording").
      expect(v.ok, `${def.key}: ${v.ok ? '' : v.error}`).toBe(true);
    }
  });

  it('rejects out-of-range numbers and unknown options', () => {
    const port = SETTINGS.find((d) => d.key === 'calls.max_concurrent');
    expect(validateSettingValue(port, 0).ok).toBe(false);
    expect(validateSettingValue(port, '12').ok).toBe(true);
    const mode = SETTINGS.find((d) => d.key === 'speech.tts_provider');
    expect(validateSettingValue(mode, 'polly').ok).toBe(false);
  });
});

describe('settings runtime', () => {
  let rows;
  let saved;

  beforeEach(() => {
    __resetSettingsRuntime();
    rows = [];
    saved = vi.fn().mockResolvedValue();
    process.env.MAX_CONCURRENT_CALLS = '7';
    delete process.env.ANTHROPIC_TIMEOUT_MS;
  });
  afterEach(() => {
    __resetSettingsRuntime();
    delete process.env.MAX_CONCURRENT_CALLS;
  });

  const start = () => startSettings({ app: 'worker', load: async () => rows, saveReport: saved, logger: quiet, intervalMs: 1e9 });

  it('prefers the panel, then the server .env, then the default', async () => {
    await start();
    expect(setting('calls.max_concurrent')).toBe(7); // .env
    expect(setting('ai.call_timeout_ms')).toBe(12000); // default

    rows = [{ key: 'calls.max_concurrent', value: 25 }];
    await refreshSettings();
    expect(setting('calls.max_concurrent')).toBe(25);
    expect(process.env.MAX_CONCURRENT_CALLS).toBe('25');
  });

  it('puts the server value back when the panel value is cleared', async () => {
    rows = [{ key: 'calls.max_concurrent', value: 25 }];
    await start();
    rows = [];
    await refreshSettings();
    expect(process.env.MAX_CONCURRENT_CALLS).toBe('7');
    expect(setting('calls.max_concurrent')).toBe(7);
  });

  it('opens saved secrets and exposes them to code that reads process.env', async () => {
    rows = [{ key: 'integrations.sarvam_api_key', value: { sealed: sealSecret('sk-sarvam-1234'), last4: '1234' } }];
    await start();
    expect(setting('integrations.sarvam_api_key')).toBe('sk-sarvam-1234');
    expect(process.env.SARVAM_API_KEY).toBe('sk-sarvam-1234');
    // The snapshot the admin panel reads never contains the key itself.
    const snap = JSON.stringify(saved.mock.calls.at(-1));
    expect(snap).not.toContain('sk-sarvam');
    expect(snap).toContain('"last4":"1234"');
  });

  it('ignores a saved value that fails validation', async () => {
    rows = [{ key: 'calls.max_concurrent', value: 99999 }];
    await start();
    expect(setting('calls.max_concurrent')).toBe(7);
  });

  it('only touches the environment of settings this app uses', async () => {
    rows = [{ key: 'ai.portal_model', value: 'portal-model' }];
    await start();
    expect(process.env.ANTHROPIC_MODEL).not.toBe('portal-model');
  });

  it('notifies listeners only when something changed', async () => {
    await start();
    const fn = vi.fn();
    onSettingsChange(fn);
    await refreshSettings();
    expect(fn).not.toHaveBeenCalled();
    rows = [{ key: 'scripts.busy', value: 'Busy, call later.' }];
    await refreshSettings();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(settingText('scripts.busy', 'x')).toBe('Busy, call later.');
  });

  it('keeps working on defaults when the database is unreachable', async () => {
    await startSettings({ app: 'worker', load: async () => { throw new Error('db down'); }, logger: quiet, intervalMs: 1e9 });
    expect(setting('calls.idle_hangup_seconds')).toBe(45);
  });
});
