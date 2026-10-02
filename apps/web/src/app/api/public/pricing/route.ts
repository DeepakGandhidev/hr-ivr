import { NextResponse } from "next/server";
import { currentPlans, currentTrial, livePacks, publicPack, publicPlan, trialAllowance } from "@/lib/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Published pricing, for everything outside the portal that quotes a price:
 * the website's pricing page and Saarthi's answers.
 *
 * It reads the same rows the portal's Subscription page reads, and the admin
 * panel publishes them in one transaction, so all three switch together.
 * `slashedPriceInr` is display only: a struck-through figure beside the sale
 * price, never charged and never invoiced.
 */
export async function GET() {
  const [plans, trial, packs] = await Promise.all([currentPlans(undefined, { publicOnly: true }), currentTrial(), livePacks()]);
  const t = trialAllowance(trial);
  const publishedAt = [...plans.map((p) => p.publishedAt), trial?.publishedAt]
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  return NextResponse.json(
    {
      currency: "INR",
      taxNote: "Prices exclude GST at 18%.",
      slashedPriceRule:
        "A slashed price shows struck through beside the sale price; the sale price is the only one ever charged or invoiced.",
      plans: plans.map(publicPlan),
      trial: { minutes: t.minutes, days: t.days, screenings: t.screenings, jobLimit: t.jobs },
      topUpPacks: packs.map(publicPack),
      publishedAt,
    },
    {
      headers: {
        // Never cached: a publish must reach the website at the same moment it
        // reaches the portal, not a cache lifetime later.
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
