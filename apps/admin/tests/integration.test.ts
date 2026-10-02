/**
 * The build request's "Done when" checks, run against a real database (the
 * local demo seed). Skipped unless ADMIN_IT=1, because they write to it.
 *
 *   ADMIN_IT=1 ADMIN_APP_DATABASE_URL=postgresql://pratibha_admin:...@localhost:5432/pratibha_demo npx vitest run tests/integration.test.ts
 */
import { describe, expect, it, beforeAll } from "vitest";
import type { AdminUser, Tenant } from "@pratibha/prisma";
import { db } from "@/lib/db";

const run = process.env.ADMIN_IT === "1" ? describe : describe.skip;

run("done-when checks against the demo database", () => {
  let owner: AdminUser;
  let engineer: AdminUser;
  let support: AdminUser;
  let techserve: Tenant;
  let kaya: Tenant;
  let dezine: Tenant;

  beforeAll(async () => {
    owner = await db.adminUser.findFirstOrThrow({ where: { role: "owner", deactivatedAt: null } });
    engineer = await db.adminUser.findFirstOrThrow({ where: { role: "engineer", deactivatedAt: null } });
    support = await db.adminUser.findFirstOrThrow({ where: { role: "support", deactivatedAt: null } });
    techserve = await db.tenant.findUniqueOrThrow({ where: { slug: "techserve" } });
    kaya = await db.tenant.findUniqueOrThrow({ where: { slug: "kaya" } });
    dezine = await db.tenant.findUniqueOrThrow({ where: { slug: "dezine" } });
  });

  it("H10: no admin API path can modify or remove an activity row, even with a direct query", async () => {
    const row = await db.activityLog.create({
      data: { actorType: "system", action: "test.append_only", summary: "append-only probe" },
    });
    await expect(db.activityLog.update({ where: { id: row.id }, data: { summary: "edited" } })).rejects.toThrow();
    await expect(db.activityLog.delete({ where: { id: row.id } })).rejects.toThrow();
    await expect(db.$executeRawUnsafe("TRUNCATE activity_log")).rejects.toThrow();
    const still = await db.activityLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(still.summary).toBe("append-only probe");
  });

  it("D10: an aborted publish changes nothing anywhere", async () => {
    const { savePlanDraft, publishPricing } = await import("@/lib/pricing-admin");
    const { currentPlan } = await import("@/lib/pricing");
    const before = await currentPlan("growth");
    await savePlanDraft(owner, "growth", {
      priceInr: before!.priceInr + 2000,
      slashedPriceInr: null,
      minutes: before!.minutes + 50,
      screenings: before!.screenings,
      jobLimit: before!.jobLimit,
      visibility: "public",
    });
    const logsBefore = await db.activityLog.count({ where: { action: "pricing.published" } });

    await expect(publishPricing(owner, { failBeforeCommit: true })).rejects.toThrow(/Simulated failure/);

    const after = await currentPlan("growth");
    expect(after!.id).toBe(before!.id);
    expect(after!.priceInr).toBe(before!.priceInr);
    expect(await db.plan.count({ where: { key: "growth", status: "draft" } })).toBe(1);
    expect(await db.activityLog.count({ where: { action: "pricing.published" } })).toBe(logsBefore);
  });

  it("A20: Engineer and Support cannot reach publish; an Owner's publish switches everything at once", async () => {
    const { can } = await import("@/lib/auth/roles");
    expect(can(support.role, "pricing.publish")).toBe(false);
    expect(can(engineer.role, "pricing.publish")).toBe(false);

    const { publishPricing } = await import("@/lib/pricing-admin");
    const { currentPlan } = await import("@/lib/pricing");
    const old = await currentPlan("growth");
    const draft = await db.plan.findFirstOrThrow({ where: { key: "growth", status: "draft" } });
    await publishPricing(owner);
    const live = await currentPlan("growth");
    expect(live!.id).toBe(draft.id);
    expect(live!.version).toBe(old!.version + 1);
    expect(live!.publishedBy).toBe(owner.id);
    // The worker reads limits.screenings; it moved with the row.
    expect((live!.limits as Record<string, number>).interviewMinutes).toBe(live!.minutes);
  });

  it("D10: a grandfathered workspace still renews at its old price", async () => {
    const { recordManualPayment } = await import("@/lib/payments-admin");
    const ts = await db.tenant.findUniqueOrThrow({ where: { id: techserve.id }, include: { plan: true } });
    const live = await db.plan.findFirstOrThrow({ where: { key: "growth", status: "published" }, orderBy: { version: "desc" } });
    expect(ts.plan.id).not.toBe(live.id);
    expect(ts.plan.priceInr).toBeLessThan(live.priceInr);

    await recordManualPayment(owner, { workspaceId: ts.id, kind: "subscription", status: "captured", method: "upi", reason: "renewal test" });
    const p = await db.payment.findFirstOrThrow({ where: { tenantId: ts.id, kind: "subscription" }, orderBy: { createdAt: "desc" } });
    expect(p.amountPaise).toBe(ts.plan.priceInr * 100);
  });

  it("F10: invoices carry the GSTIN and the right split, same state and different state", async () => {
    const { recordManualPayment } = await import("@/lib/payments-admin");
    // Seller is Karnataka (the default); Kaya is in Karnataka, TechServe in Haryana.
    await recordManualPayment(owner, { workspaceId: kaya.id, kind: "subscription", status: "captured", method: "upi", reason: "same-state sample" });
    const same = await db.payment.findFirstOrThrow({ where: { tenantId: kaya.id, status: "captured" }, orderBy: { createdAt: "desc" }, include: { invoice: true } });
    expect(same.invoice).not.toBeNull();
    expect((same.invoice!.buyer as Record<string, string>).gstin).toBe("29AAECK5678M1Z2");
    expect(same.invoice!.cgstPaise).toBeGreaterThan(0);
    expect(same.invoice!.sgstPaise).toBe(same.invoice!.cgstPaise + (same.invoice!.sgstPaise - same.invoice!.cgstPaise));
    expect(same.invoice!.igstPaise).toBe(0);
    expect(same.invoice!.cgstPaise + same.invoice!.sgstPaise).toBe(Math.round(((same.invoice!.subtotalPaise - same.invoice!.discountPaise) * 18) / 100));

    const diff = await db.payment.findFirstOrThrow({ where: { tenantId: techserve.id, status: "captured", kind: "subscription" }, orderBy: { createdAt: "desc" }, include: { invoice: true } });
    expect((diff.invoice!.buyer as Record<string, string>).gstin).toBe("06AABCT1234F1Z8");
    expect(diff.invoice!.igstPaise).toBe(Math.round(((diff.invoice!.subtotalPaise - diff.invoice!.discountPaise) * 18) / 100));
    expect(diff.invoice!.cgstPaise + diff.invoice!.sgstPaise).toBe(0);

    // Kaya was past due; a captured charge clears it.
    expect((await db.tenant.findUniqueOrThrow({ where: { id: kaya.id } })).status).toBe("active");
  });

  it("E10: the cap refuses redemption #51, and an ended code cannot attach to anything", async () => {
    const { createCoupon, endCoupon, redeemOnPayment } = await import("@/lib/coupons");
    const code = `CAP${Date.now().toString().slice(-6)}`;
    const { id } = await createCoupon(owner, { code, kind: "percent", value: 10, applicablePlans: [], cap: 50, startsAt: null, expiresAt: null, draft: false });
    await db.coupon.update({ where: { id }, data: { redeemedCount: 50 } });
    const sub = await db.subscription.findUniqueOrThrow({ where: { tenantId: dezine.id } });
    await expect(
      db.$transaction((tx) => redeemOnPayment(tx, { code, subscription: sub, planKey: "growth", amountPaise: 1_000_000 }))
    ).rejects.toThrow(/reached its cap of 50/);
    expect((await db.coupon.findUniqueOrThrow({ where: { id } })).redeemedCount).toBe(50);

    await endCoupon(owner, id, "test");
    await expect(
      db.$transaction((tx) => redeemOnPayment(tx, { code, subscription: sub, planKey: "growth", amountPaise: 1_000_000 }))
    ).rejects.toThrow(/ended and cannot be attached/);
    await expect(createCoupon(owner, { code, kind: "percent", value: 10, applicablePlans: [], cap: null, startsAt: null, expiresAt: null, draft: false })).rejects.toThrow(/never reused/);
  });

  it("C20: delete refuses without the typed name and a second admin", async () => {
    const { requestDeletion, confirmDeletion, cancelDeletionRequest } = await import("@/lib/workspace-actions");
    await expect(requestDeletion(owner, dezine.id, "Dezine", "test")).rejects.toThrow(/exactly as shown/);
    await requestDeletion(owner, dezine.id, "Dezine Labs", "test");
    await expect(confirmDeletion(owner, dezine.id, "Dezine Labs", "test")).rejects.toThrow(/second admin/);
    await expect(confirmDeletion(support, dezine.id, "Dezine Labs", "test")).rejects.toThrow(/Support cannot approve/);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: dezine.id } })).status).not.toBe("deleted_pending");
    await cancelDeletionRequest(owner, dezine.id, "test over");
  });

  it("C30: suspend, then a held deletion, then restore, returns the workspace exactly as it was", async () => {
    const { suspend, resume, requestDeletion, confirmDeletion, restore } = await import("@/lib/workspace-actions");
    const before = await db.tenant.findUniqueOrThrow({ where: { id: dezine.id } });
    await suspend(owner, dezine.id, "test");
    expect((await db.tenant.findUniqueOrThrow({ where: { id: dezine.id } })).status).toBe("suspended");
    await resume(owner, dezine.id, "test");
    expect((await db.tenant.findUniqueOrThrow({ where: { id: dezine.id } })).status).toBe(before.status);

    await requestDeletion(owner, dezine.id, "Dezine Labs", "test");
    await confirmDeletion(engineer, dezine.id, "Dezine Labs", "second admin approves");
    const held = await db.tenant.findUniqueOrThrow({ where: { id: dezine.id } });
    expect(held.status).toBe("deleted_pending");
    expect(held.deletionHoldUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    await restore(owner, dezine.id, "test");
    const back = await db.tenant.findUniqueOrThrow({ where: { id: dezine.id } });
    expect(back.status).toBe(before.status);
    expect(back.planId).toBe(before.planId);
    expect(back.deletionHoldUntil).toBeNull();
  });

  it("A20: Support's goodwill grant is capped", async () => {
    const { grantGoodwill } = await import("@/lib/workspace-actions");
    await expect(grantGoodwill(support, techserve.id, 500, "too many")).rejects.toThrow(/up to 100/);
    const sub = await db.subscription.findUniqueOrThrow({ where: { tenantId: techserve.id } });
    await grantGoodwill(support, techserve.id, 20, "small grant");
    const after = await db.subscription.findUniqueOrThrow({ where: { tenantId: techserve.id } });
    expect(after.topUpMinutes).toBe(sub.topUpMinutes + 20);
  });
});
