import { prisma } from '@pratibha/prisma';
import { onSettingsChange, startSettings } from '@pratibha/shared/settings-runtime';
import { loadConfig } from './index.js';

/**
 * Keep the worker's config in step with the admin panel.
 *
 * The settings runtime writes saved values into process.env; this rebuilds
 * the config from it and copies the result into the existing object, so every
 * holder of `config` (agent, tools, call sessions) sees the new values without
 * being handed a new object. Port and logging are start-up only.
 */
function assignDeep(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      assignDeep(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

export function reloadConfigInto(config) {
  const { port: _port, logging: _logging, ...fresh } = loadConfig();
  assignDeep(config, fresh);
}

export async function startWorkerSettings(logger = console) {
  await startSettings({
    app: 'worker',
    load: () => prisma.platformSetting.findMany({ select: { key: true, value: true } }),
    saveReport: async (app, values) => {
      await prisma.appRuntimeReport.upsert({ where: { app }, update: { values }, create: { app, values } });
    },
    logger,
  });
}

export function followSettings(config, logger = console) {
  return onSettingsChange(() => {
    reloadConfigInto(config);
    logger.info?.('Platform settings changed; configuration reloaded');
  });
}
