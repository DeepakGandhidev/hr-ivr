import { setting } from "@pratibha/shared/settings-runtime";
import { runRenewals } from "@/lib/autopay";

/** Hourly: raise AutoPay renewals coming due and retry failed ones, unless switched off in the admin panel. */
export function startRenewals() {
  if (process.env.RENEWALS_DISABLED === "true") return;
  const run = () => {
    if (!setting<boolean>("features.renewals_enabled")) return;
    void runRenewals().catch((err) => console.error("[autopay] renewal run failed", err));
  };
  setTimeout(run, 60_000);
  setInterval(run, 3_600_000);
}
