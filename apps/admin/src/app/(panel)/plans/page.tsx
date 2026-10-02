import { requireAdminPage } from "@/lib/auth/session";
import { can, refusalReason } from "@/lib/auth/roles";
import { pricingBoard } from "@/lib/pricing-admin";
import { longDate } from "@/lib/format";
import { PlansBoard } from "./PlansBoard";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const { admin } = await requireAdminPage();
  const board = await pricingBoard();

  return (
    <PlansBoard
      canEdit={can(admin.role, "pricing.edit")}
      canPublish={can(admin.role, "pricing.publish")}
      editRefusal={refusalReason(admin.role, "pricing.edit")}
      publishRefusal={refusalReason(admin.role, "pricing.publish")}
      lastPublished={board.lastPublishedAt ? `${longDate(board.lastPublishedAt)}${board.lastPublisher ? ` by ${board.lastPublisher}` : ""}` : null}
      pending={board.pendingCount}
      plans={board.plans.map((p) => ({
        key: p.live.key,
        name: p.live.name,
        version: p.live.version,
        live: fields(p.live),
        draft: p.draft ? fields(p.draft) : null,
        changes: p.changes,
        workspaces: p.workspaces,
        mrr: p.mrr,
        grandfathered: p.grandfathered,
      }))}
      packs={board.published.map((p) => ({
        id: p.id,
        kind: p.kind,
        quantity: p.quantity,
        priceInr: p.priceInr,
        validityDays: p.validityDays,
        draft: board.packDrafts.find((d) => d.replacesId === p.id) ?? null,
      }))}
      newPacks={board.packDrafts.filter((d) => !d.replacesId)}
      trial={board.trial ? { minutes: board.trial.minutes, days: board.trial.days } : { minutes: 50, days: 15 }}
      trialDraft={board.trialDraft ? { minutes: board.trialDraft.minutes, days: board.trialDraft.days } : null}
    />
  );
}

function fields(p: { priceInr: number; slashedPriceInr: number | null; minutes: number; screenings: number; jobLimit: number | null; visibility: "public" | "hidden" }) {
  return {
    priceInr: p.priceInr,
    slashedPriceInr: p.slashedPriceInr,
    minutes: p.minutes,
    screenings: p.screenings,
    jobLimit: p.jobLimit,
    visibility: p.visibility,
  };
}
