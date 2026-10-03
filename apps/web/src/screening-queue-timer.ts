import { runScreeningQueue } from "@/lib/screening-runner";

/** Every minute: screen whatever Auto mode, Screen now or a move has queued. */
export function startScreeningQueue() {
  if (process.env.SCREENING_QUEUE_DISABLED === "true") return;
  setTimeout(() => void runScreeningQueue(), 15_000);
  setInterval(() => void runScreeningQueue(), 60_000);
}
