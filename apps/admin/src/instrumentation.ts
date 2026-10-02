/** Starts the hourly sweep (see sweep.ts), on the Node server only. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSweep } = await import("./sweep");
    startSweep();
  }
}
