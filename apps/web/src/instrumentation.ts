/**
 * On the Node server only: load platform settings first (so everything after
 * starts with the admin panel's values), then the screening queue runner,
 * AutoPay renewals and the Monday summary email.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPlatformSettings } = await import("./lib/settings-runtime");
    await startPlatformSettings();
    const { startScreeningQueue } = await import("./screening-queue-timer");
    startScreeningQueue();
    const { startRenewals } = await import("./renewal-timer");
    startRenewals();
    const { startWeeklySummaries } = await import("./weekly-summary-timer");
    startWeeklySummaries();
    const { startInvoiceEmails } = await import("./invoice-email-timer");
    startInvoiceEmails();
    const { startSaarthiKeepAlive } = await import("./saarthi-keepalive");
    startSaarthiKeepAlive();
  }
}
