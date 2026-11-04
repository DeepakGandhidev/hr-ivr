import { setting } from "@pratibha/shared/settings-runtime";
import { runScreeningQueue } from "@/lib/screening-runner";

/**
 * Screen whatever Auto mode, Screen now or a move has queued. The switch is
 * read on every tick, so turning it off in the admin panel stops the next run.
 */
export function startScreeningQueue() {
  if (process.env.SCREENING_QUEUE_DISABLED === "true") return;
  const run = () => {
    if (setting<boolean>("features.screening_queue_enabled")) void runScreeningQueue();
  };
  const everyMs = Math.max(10, setting<number>("screening.queue_interval_seconds")) * 1000;
  setTimeout(run, 15_000);
  setInterval(run, everyMs);
}
