/** Starts the screening queue runner, on the Node server only. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScreeningQueue } = await import("./screening-queue-timer");
    startScreeningQueue();
  }
}
