import { adminPrisma } from "@pratibha/prisma";
import type { Prisma } from "@pratibha/prisma";
import { startSettings } from "@pratibha/shared/settings-runtime";

/**
 * Keep the portal's copy of platform settings fresh, and report what it runs
 * with to app_runtime_reports (the portal can only read platform_settings).
 */
export function startPlatformSettings() {
  return startSettings({
    app: "web",
    load: () => adminPrisma.platformSetting.findMany({ select: { key: true, value: true } }),
    saveReport: async (app, values) => {
      await adminPrisma.appRuntimeReport.upsert({
        where: { app },
        update: { values: values as Prisma.InputJsonValue },
        create: { app, values: values as Prisma.InputJsonValue },
      });
    },
    logger: { warn: (...args: unknown[]) => console.warn("[settings]", ...args) },
  });
}
