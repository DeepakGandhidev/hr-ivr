import { requireAdminPage } from "@/lib/auth/session";
import { can, refusalReason } from "@/lib/auth/roles";
import { entitlementsOf, pricingBoard } from "@/lib/pricing-admin";
import { GATE_OPTIONS, getSetting } from "@/lib/settings";
import { PLAN_FEATURES, PLAN_LIMITS } from "@pratibha/shared";
import { longDate } from "@/lib/format";
import { PlansBoard } from "./PlansBoard";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const { admin } = await requireAdminPage();
  const [board, portalGate, tuningGate] = await Promise.all([
    pricingBoard(),
    getSetting("gate.portal_posts"),
    getSetting("gate.interview_tuning"),
  ]);
  const gateLabel = (v: unknown) => GATE_OPTIONS.find((o) => o.value === v)?.label ?? "Every plan";
  const gates: Record<string, string> = {
    "gate.portal_posts": gateLabel(portalGate),
    "gate.interview_tuning": gateLabel(tuningGate),
  };
  // The catalogue as plain data, so the client bundle does not pull in the
  // shared package (and zod with it).
  const catalogue = {
    features: PLAN_FEATURES.map((f) => ({
      key: f.key,
      label: f.label,
      help: f.help,
      defaults: { ...f.defaults },
      enforced: f.enforced,
      gate: "legacyGate" in f ? gates[f.legacyGate] : null,
    })),
    limits: PLAN_LIMITS.filter((l) => !("column" in l)).map((l) => ({
      key: l.key,
      label: l.label,
      unit: l.unit,
      help: l.help,
      defaults: { ...l.defaults },
      enforced: l.enforced,
    })),
  };

  return (
    <PlansBoard
      canEdit={can(admin.role, "pricing.edit")}
      canPublish={can(admin.role, "pricing.publish")}
      editRefusal={refusalReason(admin.role, "pricing.edit")}
      publishRefusal={refusalReason(admin.role, "pricing.publish")}
      lastPublished={board.lastPublishedAt ? `${longDate(board.lastPublishedAt)}${board.lastPublisher ? ` by ${board.lastPublisher}` : ""}` : null}
      pending={board.pendingCount}
      catalogue={catalogue}
      plans={board.plans.map((p) => ({
        key: p.live.key,
        name: p.live.name,
        version: p.live.version,
        live: fields(p.live),
        draft: p.draft ? fields(p.draft) : null,
        liveIncludes: entitlementsOf(p.live),
        draftIncludes: p.draft ? entitlementsOf(p.draft) : null,
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
