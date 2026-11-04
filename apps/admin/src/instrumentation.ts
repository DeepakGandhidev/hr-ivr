/**
 * On the Node server only: load platform settings (so shared code here, such
 * as invoice GST, follows the panel like the portal does), then start the
 * hourly sweep (see sweep.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSettings } = await import("@pratibha/shared/settings-runtime");
    const { db } = await import("./lib/db");
    await startSettings({
      app: "admin",
      load: () => db.platformSetting.findMany({ select: { key: true, value: true } }),
      logger: { warn: (...args: unknown[]) => console.warn("[settings]", ...args) },
    });
    const { startSweep } = await import("./sweep");
    startSweep();
  }
}
