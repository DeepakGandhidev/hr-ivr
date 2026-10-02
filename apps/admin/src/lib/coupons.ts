import type { AdminUser, Coupon, CouponStatus, Subscription } from "@pratibha/prisma";
import { db, type Tx } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import { badRequest, conflict, notFound } from "@/lib/http";

/**
 * Coupons: draft → scheduled → active ⇄ paused → ended.
 *
 * Every transition has a named actor and a log row. An admin makes the
 * deliberate ones (create, schedule, pause, resume, end, edit caps); the
 * system sweep makes the two that are only a matter of time (a scheduled code
 * reaching its start, an active one reaching its expiry). Ended is final, and
 * a code is never reused: it stays in the table, unique, forever.
 */

/** What the code is right now, even between sweeps. */
export function effectiveStatus(c: Pick<Coupon, "status" | "startsAt" | "expiresAt">, now = new Date()): CouponStatus {
  if (c.status === "draft" || c.status === "paused" || c.status === "ended") return c.status;
  if (c.expiresAt && c.expiresAt <= now) return "ended";
  if (c.startsAt && c.startsAt > now) return "scheduled";
  return "active";
}

export function describeCoupon(c: Pick<Coupon, "kind" | "value">): string {
  if (c.kind === "percent") return `${c.value}% off the first invoice`;
  if (c.kind === "amount") return `₹${(c.value / 100).toLocaleString("en-IN")} off the first invoice`;
  return `${c.value} free interview minutes`;
}

export interface CouponInput {
  code: string;
  kind: "percent" | "amount";
  /** Percent 1–100, or rupees for a flat amount (stored in paise). */
  value: number;
  applicablePlans: string[];
  cap: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  draft: boolean;
}

export async function createCoupon(admin: AdminUser, input: CouponInput) {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,24}$/.test(code)) throw badRequest("A code is 3 to 24 letters and numbers, no spaces.");
  if (input.kind === "percent" && (!Number.isInteger(input.value) || input.value < 1 || input.value > 100)) {
    throw badRequest("A percent coupon is between 1 and 100.");
  }
  if (input.kind === "amount" && (!Number.isInteger(input.value) || input.value < 1)) {
    throw badRequest("A flat coupon is a whole number of rupees.");
  }
  if (input.cap !== null && (!Number.isInteger(input.cap) || input.cap < 1)) throw badRequest("A cap is a whole number of redemptions.");
  if (input.startsAt && input.expiresAt && input.expiresAt <= input.startsAt) {
    throw badRequest("The code must expire after it starts.");
  }
  if (input.expiresAt && input.expiresAt <= new Date()) throw badRequest("That expiry is already in the past.");

  const existing = await db.coupon.findUnique({ where: { code } });
  if (existing) {
    throw conflict(
      existing.status === "ended" || effectiveStatus(existing) === "ended"
        ? `${code} was used before and has ended. Codes are never reused; choose another.`
        : `${code} already exists.`
    );
  }

  const status: CouponStatus = input.draft ? "draft" : input.startsAt && input.startsAt > new Date() ? "scheduled" : "active";
  return db.$transaction(async (tx) => {
    const coupon = await tx.coupon.create({
      data: {
        code,
        kind: input.kind,
        value: input.kind === "amount" ? input.value * 100 : input.value,
        applicablePlans: input.applicablePlans,
        maxRedemptions: input.cap,
        startsAt: input.startsAt,
        expiresAt: input.expiresAt,
        status,
        active: status === "active",
        createdBy: admin.id,
      },
    });
    await recordActivity(
      {
        actor: admin,
        action: "coupon.created",
        summary: `${admin.name} created ${code}: ${describeCoupon(coupon)}, ${status === "scheduled" ? `scheduled for ${input.startsAt!.toDateString()}` : status}`,
        after: snapshot(coupon),
      },
      tx
    );
    return { message: `${code} is ${status === "scheduled" ? "scheduled" : status}.`, id: coupon.id };
  });
}

function snapshot(c: Coupon) {
  return {
    code: c.code,
    kind: c.kind,
    value: c.value,
    applicablePlans: c.applicablePlans,
    cap: c.maxRedemptions,
    startsAt: c.startsAt?.toISOString() ?? null,
    expiresAt: c.expiresAt?.toISOString() ?? null,
    status: c.status,
  };
}

async function transition(admin: AdminUser | null, id: string, to: CouponStatus, verb: string, reason?: string) {
  return db.$transaction(async (tx) => {
    const c = await tx.coupon.findUnique({ where: { id } });
    if (!c) throw notFound("That coupon does not exist.");
    const now = effectiveStatus(c);
    const allowed: Record<CouponStatus, CouponStatus[]> = {
      draft: ["scheduled", "active", "ended"],
      scheduled: ["paused", "ended", "active"],
      active: ["paused", "ended"],
      paused: ["active", "scheduled", "ended"],
      ended: [],
    };
    if (!allowed[now].includes(to)) {
      throw conflict(now === "ended" ? `${c.code} has ended. Ended codes stay ended.` : `${c.code} cannot go from ${now} to ${to}.`);
    }
    // Resuming or scheduling lands on whichever the dates say.
    const target: CouponStatus = to === "active" || to === "scheduled" ? (c.startsAt && c.startsAt > new Date() ? "scheduled" : "active") : to;
    const updated = await tx.coupon.update({
      where: { id },
      data: { status: target, active: target === "active", ...(target === "ended" ? { endedAt: new Date() } : {}) },
    });
    await recordActivity(
      {
        actorType: admin ? "admin" : "system",
        actor: admin,
        action: `coupon.${target === "ended" ? "ended" : verb}`,
        summary: `${admin ? admin.name : "The system"} ${target === "ended" ? "ended" : verb} ${c.code}`,
        reason: reason ?? null,
        before: { status: now },
        after: { status: target },
      },
      tx
    );
    return { message: `${c.code} is ${target}.` };
  });
}

export const pauseCoupon = (admin: AdminUser, id: string, reason?: string) => transition(admin, id, "paused", "paused", reason);
export const resumeCoupon = (admin: AdminUser, id: string, reason?: string) => transition(admin, id, "active", "resumed", reason);
export const scheduleCoupon = (admin: AdminUser, id: string, reason?: string) => transition(admin, id, "scheduled", "scheduled", reason);
export const endCoupon = (admin: AdminUser, id: string, reason?: string) => transition(admin, id, "ended", "ended", reason);

export async function editCaps(admin: AdminUser, id: string, input: { cap: number | null; expiresAt: Date | null }) {
  return db.$transaction(async (tx) => {
    const c = await tx.coupon.findUnique({ where: { id } });
    if (!c) throw notFound("That coupon does not exist.");
    if (effectiveStatus(c) === "ended") throw conflict(`${c.code} has ended. Ended codes stay ended.`);
    if (input.cap !== null && input.cap < c.redeemedCount) {
      throw badRequest(`${c.code} has already been redeemed ${c.redeemedCount} times; the cap cannot be lower.`);
    }
    if (input.expiresAt && input.expiresAt <= new Date()) throw badRequest("That expiry is already in the past. Use End now instead.");
    const updated = await tx.coupon.update({ where: { id }, data: { maxRedemptions: input.cap, expiresAt: input.expiresAt } });
    await recordActivity(
      {
        actor: admin,
        action: "coupon.caps_edited",
        summary: `${admin.name} changed the caps on ${c.code}`,
        before: { cap: c.maxRedemptions, expiresAt: c.expiresAt?.toISOString() ?? null },
        after: { cap: updated.maxRedemptions, expiresAt: updated.expiresAt?.toISOString() ?? null },
      },
      tx
    );
    return { message: `Caps on ${c.code} updated.` };
  });
}

/**
 * Attach a code to a manually recorded payment, inside that payment's
 * transaction. Refuses an ended or paused code, a plan it does not cover, and
 * the redemption past its cap: the cap is checked and taken in one UPDATE, so
 * redemption #51 of a 50-cap code is refused even when two land together.
 *
 * A workspace that already redeemed the code in the portal (waiting for its
 * next invoice) has that redemption attached here, not a second one.
 */
export async function redeemOnPayment(
  tx: Tx,
  input: { code: string; subscription: Subscription; planKey: string; amountPaise: number }
): Promise<{ coupon: Coupon; discountPaise: number; redemptionId: string }> {
  const code = input.code.trim().toUpperCase();
  const coupon = await tx.coupon.findUnique({ where: { code } });
  if (!coupon) throw badRequest(`There is no coupon ${code}.`);
  const status = effectiveStatus(coupon);
  if (status !== "active") throw badRequest(`${code} is ${status} and cannot be attached to anything.`);
  if (coupon.kind === "minutes") throw badRequest(`${code} grants minutes, not a discount; it cannot go on a payment.`);
  if (coupon.applicablePlans.length > 0 && !coupon.applicablePlans.includes(input.planKey)) {
    throw badRequest(`${code} applies to ${coupon.applicablePlans.join(", ")} only.`);
  }

  const discountPaise =
    coupon.kind === "percent" ? Math.floor((input.amountPaise * coupon.value) / 100) : Math.min(coupon.value, input.amountPaise);

  const existing = await tx.couponRedemption.findUnique({
    where: { couponId_subscriptionId: { couponId: coupon.id, subscriptionId: input.subscription.id } },
  });
  if (existing?.paymentId) throw badRequest(`This workspace has already used ${code} on an earlier payment.`);

  if (existing) {
    const r = await tx.couponRedemption.update({ where: { id: existing.id }, data: { discountPaise } });
    return { coupon, discountPaise, redemptionId: r.id };
  }

  const taken = await tx.coupon.updateMany({
    where: { id: coupon.id, ...(coupon.maxRedemptions !== null ? { redeemedCount: { lt: coupon.maxRedemptions } } : {}) },
    data: { redeemedCount: { increment: 1 } },
  });
  if (taken.count === 0) {
    throw conflict(`${code} has reached its cap of ${coupon.maxRedemptions} redemptions.`);
  }
  const r = await tx.couponRedemption.create({
    data: { couponId: coupon.id, subscriptionId: input.subscription.id, discountPaise },
  });
  return { coupon, discountPaise, redemptionId: r.id };
}

/** The sweep's half of the lifecycle: start what is due, end what has expired. */
export async function sweepCoupons(now = new Date()) {
  const due = await db.coupon.findMany({
    where: {
      OR: [
        { status: "scheduled", startsAt: { lte: now } },
        { status: { in: ["draft", "scheduled", "active", "paused"] }, expiresAt: { lte: now } },
      ],
    },
  });
  for (const c of due) {
    const to: CouponStatus = c.expiresAt && c.expiresAt <= now ? "ended" : "active";
    await db.$transaction(async (tx) => {
      await tx.coupon.update({
        where: { id: c.id },
        data: { status: to, active: to === "active", ...(to === "ended" ? { endedAt: c.expiresAt ?? now } : {}) },
      });
      await recordActivity(
        {
          actorType: "system",
          action: to === "ended" ? "coupon.ended" : "coupon.started",
          summary: to === "ended" ? `${c.code} reached its expiry and ended` : `${c.code} reached its start date and is active`,
          before: { status: c.status },
          after: { status: to },
        },
        tx
      );
    });
  }
  return due.length;
}
