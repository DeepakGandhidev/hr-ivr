import { runWeeklySummaries } from "@/lib/weekly-summary";

/**
 * Every 15 minutes: on Monday from 09:00 India time, send last week's summary
 * to each active workspace. Whether it goes out at all is the email's own
 * switch in the admin panel (Emails, Weekly summary).
 */
export function startWeeklySummaries() {
  if (process.env.WEEKLY_SUMMARY_DISABLED === "true") return;
  const run = () => {
    void runWeeklySummaries().catch((err) => console.error("[weekly-summary] run failed", err));
  };
  setTimeout(run, 90_000);
  setInterval(run, 15 * 60_000);
}
