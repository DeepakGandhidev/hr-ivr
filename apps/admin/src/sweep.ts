import { sweepCoupons } from "@/lib/coupons";
import { eraseHeldWorkspaces } from "@/lib/workspace-actions";

/**
 * The system's half of the lifecycles, run hourly inside the admin process:
 * scheduled coupons start, expired ones end, and workspaces whose hold has
 * passed are erased. Each writes its own activity rows as the system.
 *
 * Runs whether or not the panel's flag is on, because these are commitments
 * already made (a hold that has run out must not wait for someone to open the
 * panel), and none of them makes a decision a human has not already made.
 */
export function startSweep() {
  if (process.env.ADMIN_SWEEP_DISABLED === "true") return;

  const run = async () => {
    try {
      const coupons = await sweepCoupons();
      const erased = await eraseHeldWorkspaces();
      if (coupons || erased) console.info(`[admin sweep] coupons moved: ${coupons}, workspaces erased: ${erased}`);
    } catch (error) {
      console.error("[admin sweep] failed", error);
    }
  };

  setTimeout(run, 30_000);
  setInterval(run, 60 * 60_000);
}
