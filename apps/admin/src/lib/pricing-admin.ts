import type { AdminUser, Plan, PlanVisibility, TopupPack, TopupPackKind, TrialConfig } from "@pratibha/prisma";
import { db, type Tx } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import { badRequest, conflict, notFound } from "@/lib/http";
import { currentPlans, currentTrial, limitsJson, packLabel, sortPlans } from "@/lib/pricing";
import { PAYING, mrrOf } from "@/lib/workspaces";

/**
 * Drafts and the publish that makes them live.
 *
 * An edit never touches what is live: it writes a draft row (a plan version
 * one above the live one, a pack with `replacesId`, a trial row in draft).
 * Publishing flips every draft in one transaction, under an advisory lock, so
 * two admins publishing at once queue rather than interleave, and a failure at
 * any step rolls the whole thing back: the website, the portal and Saarthi all
 * read these rows, so either all of them see the new prices or none do.
 */

export interface PlanFields {
  priceInr: number;
  slashedPriceInr: number | null;
  minutes: number;
  screenings: number;
  jobLimit: number | null;
  visibility: PlanVisibility;
}

const PLAN_FIELDS: (keyof PlanFields)[] = ["priceInr", "slashedPriceInr", "minutes", "screenings", "jobLimit", "visibility"];

export function validatePlanFields(f: PlanFields) {
  const whole = (n: number) => Number.isInteger(n) && n > 0;
  if (!whole(f.priceInr)) throw badRequest("The sale price must be a whole number of rupees above zero.");
  if (f.slashedPriceInr !== null && (!whole(f.slashedPriceInr) || f.slashedPriceInr <= f.priceInr)) {
    throw badRequest("A slashed price must be higher than the sale price, or left blank.");
  }
  if (!whole(f.minutes)) throw badRequest("Interview minutes must be a whole number above zero.");
  if (!whole(f.screenings)) throw badRequest("CV screenings must be a whole number above zero.");
  if (f.jobLimit !== null && !whole(f.jobLimit)) throw badRequest("Open jobs must be a whole number, or Unlimited.");
}

function sameFields(a: PlanFields, b: Pick<Plan, keyof PlanFields>) {
  return PLAN_FIELDS.every((k) => a[k] === b[k]);
}

function describeChange(live: Pick<Plan, keyof PlanFields>, draft: Pick<Plan, keyof PlanFields>): string[] {
  const out: string[] = [];
  const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  if (live.priceInr !== draft.priceInr) out.push(`${inr(live.priceInr)} to ${inr(draft.priceInr)}`);
  if (live.slashedPriceInr !== draft.slashedPriceInr) {
    out.push(draft.slashedPriceInr ? `slashed price ${inr(draft.slashedPriceInr)}` : "no slashed price");
  }
  if (live.minutes !== draft.minutes) out.push(`${live.minutes} to ${draft.minutes} minutes`);
  if (live.screenings !== draft.screenings) out.push(`${live.screenings} to ${draft.screenings} screenings`);
  if (live.jobLimit !== draft.jobLimit) {
    out.push(`${live.jobLimit ?? "unlimited"} to ${draft.jobLimit ?? "unlimited"} open jobs`);
  }
  if (live.visibility !== draft.visibility) out.push(draft.visibility === "hidden" ? "hidden from sale" : "on sale");
  return out;
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export async function pricingBoard() {
  const [live, drafts, tenants, packs, trial, trialDraft, lastPublish] = await Promise.all([
    currentPlans(),
    db.plan.findMany({ where: { status: "draft" } }),
    db.tenant.findMany({ where: { status: { in: PAYING } }, include: { plan: true } }),
    db.topupPack.findMany({ where: { status: { in: ["published", "draft"] } }, orderBy: { createdAt: "asc" } }),
    currentTrial(),
    db.trialConfig.findFirst({ where: { status: "draft" }, orderBy: { createdAt: "desc" } }),
    db.activityLog.findFirst({ where: { action: "pricing.published" }, orderBy: { at: "desc" } }),
  ]);

  const plans = sortPlans(live).map((p) => {
    const draft = drafts.find((d) => d.key === p.key) ?? null;
    const on = tenants.filter((t) => t.plan.key === p.key);
    return {
      live: p,
      draft,
      changes: draft ? describeChange(p, draft) : [],
      workspaces: on.length,
      mrr: on.reduce((s, t) => s + mrrOf(t), 0),
      // Paying on an older version of this plan, at its old price.
      grandfathered: on.filter((t) => t.planId !== p.id).length,
    };
  });

  const published = packs.filter((p) => p.status === "published");
  const packDrafts = packs.filter((p) => p.status === "draft");

  const pendingCount = drafts.length + packDrafts.length + (trialDraft ? 1 : 0);
  const lastPublishedAt =
    lastPublish?.at ??
    [...live.map((p) => p.publishedAt), trial?.publishedAt].filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ??
    null;

  return { plans, published, packDrafts, trial, trialDraft, pendingCount, lastPublishedAt, lastPublisher: lastPublish?.actorName ?? null };
}

// ---------------------------------------------------------------------------
// Plan drafts
// ---------------------------------------------------------------------------

export async function savePlanDraft(admin: AdminUser, key: string, fields: PlanFields) {
  validatePlanFields(fields);
  return db.$transaction(async (tx) => {
    const live = await tx.plan.findFirst({ where: { key, status: "published" }, orderBy: { version: "desc" } });
    if (!live) throw notFound("That plan does not exist.");
    const existing = await tx.plan.findFirst({ where: { key, status: "draft" } });

    // Edited back to what is live: there is nothing to publish for this plan.
    if (sameFields(fields, live)) {
      if (existing) await tx.plan.delete({ where: { id: existing.id } });
      return { message: `${live.name} matches what is live; no draft kept.`, draft: false };
    }

    const data = {
      key,
      name: live.name,
      version: live.version + 1,
      status: "draft" as const,
      ...fields,
      features: live.features ?? {},
      limits: limitsJson(fields, live.limits),
    };
    const draft = existing
      ? await tx.plan.update({ where: { id: existing.id }, data })
      : await tx.plan.create({ data });

    const changes = describeChange(live, draft);
    await recordActivity(
      {
        actor: admin,
        action: "pricing.draft_edited",
        summary: `${admin.name} edited the ${live.name} plan draft: ${changes.join(", ")}`,
        before: pick(live),
        after: pick(draft),
      },
      tx
    );
    return { message: `${live.name} saved as a draft. Nothing changes for anyone until you publish.`, draft: true };
  });
}

export async function discardPlanDraft(admin: AdminUser, key: string) {
  return db.$transaction(async (tx) => {
    const draft = await tx.plan.findFirst({ where: { key, status: "draft" } });
    if (!draft) throw conflict("There is no draft for that plan.");
    await tx.plan.delete({ where: { id: draft.id } });
    await recordActivity(
      { actor: admin, action: "pricing.draft_discarded", summary: `${admin.name} discarded the ${draft.name} plan draft`, before: pick(draft) },
      tx
    );
    return { message: `${draft.name} draft discarded.` };
  });
}

function pick(p: Pick<Plan, keyof PlanFields | "version">) {
  return {
    version: p.version,
    priceInr: p.priceInr,
    slashedPriceInr: p.slashedPriceInr,
    minutes: p.minutes,
    screenings: p.screenings,
    jobLimit: p.jobLimit,
    visibility: p.visibility,
  };
}

// ---------------------------------------------------------------------------
// Pack drafts
// ---------------------------------------------------------------------------

export interface PackFields {
  kind: TopupPackKind;
  quantity: number;
  priceInr: number;
  validityDays: number;
}

function validatePack(f: PackFields) {
  const whole = (n: number) => Number.isInteger(n) && n > 0;
  if (!whole(f.quantity)) throw badRequest("A pack needs a whole number of minutes or screenings.");
  if (!whole(f.priceInr)) throw badRequest("A pack needs a price in whole rupees.");
  if (!whole(f.validityDays) || f.validityDays > 730) throw badRequest("Validity is a number of days, up to two years.");
}

export async function savePackDraft(admin: AdminUser, input: PackFields & { replacesId?: string | null }) {
  validatePack(input);
  return db.$transaction(async (tx) => {
    let replaced: TopupPack | null = null;
    if (input.replacesId) {
      replaced = await tx.topupPack.findUnique({ where: { id: input.replacesId } });
      if (!replaced || replaced.status !== "published") throw badRequest("Only a live pack can be edited.");
      await tx.topupPack.deleteMany({ where: { status: "draft", replacesId: replaced.id } });
    }
    const draft = await tx.topupPack.create({
      data: {
        kind: input.kind,
        quantity: input.quantity,
        priceInr: input.priceInr,
        validityDays: input.validityDays,
        status: "draft",
        replacesId: replaced?.id ?? null,
      },
    });
    await recordActivity(
      {
        actor: admin,
        action: "pricing.pack_drafted",
        summary: replaced
          ? `${admin.name} drafted a change to the ${packLabel(replaced)} pack`
          : `${admin.name} drafted a new ${packLabel(draft)} pack`,
        before: replaced ? { ...packFields(replaced) } : null,
        after: { ...packFields(draft) },
      },
      tx
    );
    return { message: "Pack saved as a draft. It goes on sale when pricing is published." };
  });
}

export async function retirePackDraft(admin: AdminUser, packId: string) {
  return db.$transaction(async (tx) => {
    const pack = await tx.topupPack.findUnique({ where: { id: packId } });
    if (!pack || pack.status !== "published") throw badRequest("Only a live pack can be taken off sale.");
    await tx.topupPack.deleteMany({ where: { status: "draft", replacesId: pack.id } });
    await tx.topupPack.create({
      data: { ...packFields(pack), status: "draft", replacesId: pack.id, retireOnPublish: true },
    });
    await recordActivity(
      { actor: admin, action: "pricing.pack_drafted", summary: `${admin.name} drafted taking the ${packLabel(pack)} pack off sale`, before: packFields(pack) },
      tx
    );
    return { message: "The pack comes off sale when pricing is published." };
  });
}

export async function discardPackDraft(admin: AdminUser, draftId: string) {
  return db.$transaction(async (tx) => {
    const draft = await tx.topupPack.findUnique({ where: { id: draftId } });
    if (!draft || draft.status !== "draft") throw conflict("That pack has no draft to discard.");
    await tx.topupPack.delete({ where: { id: draft.id } });
    await recordActivity(
      { actor: admin, action: "pricing.draft_discarded", summary: `${admin.name} discarded a ${packLabel(draft)} pack draft`, before: packFields(draft) },
      tx
    );
    return { message: "Pack draft discarded." };
  });
}

function packFields(p: TopupPack) {
  return { kind: p.kind, quantity: p.quantity, priceInr: p.priceInr, validityDays: p.validityDays };
}

// ---------------------------------------------------------------------------
// Trial draft
// ---------------------------------------------------------------------------

export async function saveTrialDraft(admin: AdminUser, input: { minutes: number; days: number }) {
  const whole = (n: number) => Number.isInteger(n) && n > 0;
  if (!whole(input.minutes)) throw badRequest("Trial minutes must be a whole number above zero.");
  if (!whole(input.days) || input.days > 90) throw badRequest("A trial lasts between 1 and 90 days.");
  return db.$transaction(async (tx) => {
    const live = await currentTrial(tx);
    await tx.trialConfig.deleteMany({ where: { status: "draft" } });
    if (live && live.minutes === input.minutes && live.days === input.days) {
      return { message: "The trial matches what is live; no draft kept." };
    }
    await tx.trialConfig.create({
      data: {
        minutes: input.minutes,
        days: input.days,
        screenings: live?.screenings ?? 25,
        jobLimit: live?.jobLimit ?? 1,
        status: "draft",
      },
    });
    await recordActivity(
      {
        actor: admin,
        action: "pricing.draft_edited",
        summary: `${admin.name} edited the trial draft: ${input.minutes} minutes, ${input.days} days`,
        before: live ? { minutes: live.minutes, days: live.days } : null,
        after: input,
      },
      tx
    );
    return { message: "Trial saved as a draft." };
  });
}

export async function discardTrialDraft(admin: AdminUser) {
  const { count } = await db.trialConfig.deleteMany({ where: { status: "draft" } });
  if (!count) throw conflict("There is no trial draft.");
  await recordActivity({ actor: admin, action: "pricing.draft_discarded", summary: `${admin.name} discarded the trial draft` });
  return { message: "Trial draft discarded." };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export interface PublishOptions {
  /** Tests only: throw after every write, to prove a failed publish changes nothing. */
  failBeforeCommit?: boolean;
}

export async function publishPricing(admin: AdminUser, opts: PublishOptions = {}) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pratibha.pricing_publish'))`;
      const now = new Date();
      const summary: string[] = [];
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};

      const planDrafts = await tx.plan.findMany({ where: { status: "draft" } });
      for (const draft of planDrafts) {
        const live = await tx.plan.findFirst({ where: { key: draft.key, status: "published" }, orderBy: { version: "desc" } });
        if (live && draft.version <= live.version) {
          throw conflict(`The ${draft.name} draft is older than what is live. Discard it and edit again.`);
        }
        await tx.plan.update({
          where: { id: draft.id },
          data: { status: "published", publishedBy: admin.id, publishedAt: now, limits: limitsJson(draft, draft.limits) },
        });
        before[draft.key] = live ? pick(live) : null;
        after[draft.key] = pick(draft);
        summary.push(`${draft.name} ${live ? describeChange(live, draft).join(", ") : "added"}`);
      }

      const packDrafts = await tx.topupPack.findMany({ where: { status: "draft" } });
      for (const draft of packDrafts) {
        if (draft.replacesId) {
          await tx.topupPack.update({ where: { id: draft.replacesId }, data: { status: "retired" } });
        }
        if (draft.retireOnPublish) {
          await tx.topupPack.update({ where: { id: draft.id }, data: { status: "retired", publishedBy: admin.id, publishedAt: now } });
          summary.push(`${packLabel(draft)} pack taken off sale`);
        } else {
          await tx.topupPack.update({ where: { id: draft.id }, data: { status: "published", publishedBy: admin.id, publishedAt: now } });
          summary.push(`${packLabel(draft)} pack at ₹${draft.priceInr.toLocaleString("en-IN")}${draft.replacesId ? " (changed)" : " (new)"}`);
        }
      }
      if (packDrafts.length) after.packs = packDrafts.map((p) => ({ ...packFields(p), retire: p.retireOnPublish }));

      const trialDraft: TrialConfig | null = await tx.trialConfig.findFirst({ where: { status: "draft" } });
      if (trialDraft) {
        const liveTrial = await currentTrial(tx);
        await tx.trialConfig.update({ where: { id: trialDraft.id }, data: { status: "published", publishedBy: admin.id, publishedAt: now } });
        before.trial = liveTrial ? { minutes: liveTrial.minutes, days: liveTrial.days } : null;
        after.trial = { minutes: trialDraft.minutes, days: trialDraft.days };
        summary.push(`trial ${trialDraft.minutes} minutes, ${trialDraft.days} days`);
      }

      if (!summary.length) throw conflict("There is nothing to publish. Edit a plan, pack or the trial first.");

      await recordActivity(
        {
          actor: admin,
          action: "pricing.published",
          summary: `${admin.name} published pricing: ${summary.join("; ")}`,
          before,
          after,
        },
        tx
      );

      if (opts.failBeforeCommit) throw new Error("Simulated failure before commit");

      return { message: "Published. The website, the portal and Saarthi now serve these prices.", changes: summary };
    },
    { timeout: 30_000 }
  );
}

/** For a refusal or a test: is anything waiting to be published? */
export async function hasDrafts(tx: Tx | typeof db = db) {
  const [plans, packs, trials] = await Promise.all([
    tx.plan.count({ where: { status: "draft" } }),
    tx.topupPack.count({ where: { status: "draft" } }),
    tx.trialConfig.count({ where: { status: "draft" } }),
  ]);
  return plans + packs + trials > 0;
}
