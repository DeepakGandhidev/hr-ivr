#!/usr/bin/env node
/**
 * Demo data for the admin panel, matching the "Admin panel, proposed" boards:
 * the five workspaces with their plans, usage and statuses, the FIRSTHIRE
 * coupon at 9 of 50, a payment history with one failed charge, a stray caller
 * who rang six times in silence, and three admins.
 *
 * LOCAL ONLY. It refuses any database or auth service that is not on this
 * machine, because it invents customers.
 *
 *   ADMIN_APP_DATABASE_URL=postgresql://pratibha:pratibha@localhost:5432/pratibha_demo \
 *   SUPABASE_SERVICE_ROLE_KEY=... node apps/admin/scripts/seed-demo.mjs
 */
import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@pratibha/prisma";

const url = process.env.ADMIN_APP_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORTAL_PASSWORD = "pratibha123";
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? "demo-admin-pass-123";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/(localhost|127\.0\.0\.1)/.test(SUPABASE_URL)) {
  console.error("Refusing: the demo seed only runs against a local database and local Supabase.");
  process.exit(1);
}

const db = new PrismaClient({ datasources: { db: { url } } });

const DAY = 86_400_000;
const daysAgo = (n, h = 10) => new Date(Date.now() - n * DAY + (h - 10) * 3_600_000);
const period = (() => {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`;
})();

function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return ["scrypt", 16384, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
}

async function gotrueUser(email, name) {
  if (!SERVICE_KEY) return null;
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers }).then((r) => r.json());
  const existing = (list.users ?? []).find((u) => u.email === email);
  if (existing) return existing.id;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password: PORTAL_PASSWORD, email_confirm: true, user_metadata: { name } }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`GoTrue ${email}: ${JSON.stringify(body)}`);
  return body.id;
}

const WORKSPACES = [
  {
    slug: "promonkey", name: "Promonkey Technologies", plan: "scale", status: "active", joined: 19,
    minutes: 37, screenings: 61, interviews: 4,
    members: [["Gaurav Mehta", "hr@promonkey.tech", "owner"], ["Anita Rao", "anita@promonkey.tech", "reviewer"]],
    profile: { legalName: "Promonkey Technologies LLP", billingState: "Karnataka", gstin: "29AAKFP1234Q1Z5", billingAddress: "Koramangala, Bengaluru" },
  },
  {
    slug: "techserve", name: "TechServe Solutions", plan: "growth", status: "active", joined: 31,
    minutes: 600, screenings: 214, interviews: 52,
    members: [["Rohit Sharma", "rohit@techserve.in", "owner"], ["Meera Nair", "meera@techserve.in", "reviewer"], ["Arjun Rao", "arjun@techserve.in", "viewer"]],
    profile: { legalName: "TechServe Solutions Pvt Ltd", billingState: "Haryana", gstin: "06AABCT1234F1Z8", billingAddress: "Cyber City, Gurugram" },
    jobs: [["Field Sales Executive", "open"], ["Inside Sales", "open"], ["Customer Support Lead", "open"], ["Ops Analyst", "paused"]],
  },
  {
    slug: "kaya", name: "Kaya Wellness", plan: "starter", status: "past_due", joined: 43,
    minutes: 112, screenings: 88, interviews: 11,
    members: [["Priya Iyer", "priya@kayawellness.in", "owner"]],
    profile: { legalName: "Kaya Wellness Pvt Ltd", billingState: "Karnataka", gstin: "29AAECK5678M1Z2", billingAddress: "Indiranagar, Bengaluru" },
  },
  {
    slug: "brighthire", name: "BrightHire Consultants", plan: "starter", status: "trial", joined: 6,
    minutes: 18, screenings: 12, interviews: 2,
    members: [["Amit Verma", "amit@brighthire.co.in", "owner"], ["Neha Kapoor", "neha@brighthire.co.in", "admin"]],
  },
  {
    slug: "dezine", name: "Dezine Labs", plan: "growth", status: "active", joined: 14,
    minutes: 241, screenings: 160, interviews: 21,
    members: [["Kavya Menon", "kavya@dezinelabs.in", "owner"]],
    profile: { legalName: "Dezine Labs LLP", billingState: "Maharashtra", gstin: "27AAJFD4321K1Z9", billingAddress: "Lower Parel, Mumbai" },
  },
];

async function main() {
  // Pricing as the boards show it, published by Gaurav.
  const plans = {
    starter: { name: "Starter", priceInr: 4999, slashedPriceInr: 7999, minutes: 150, screenings: 400, jobLimit: 2 },
    growth: { name: "Growth", priceInr: 12999, slashedPriceInr: 19999, minutes: 600, screenings: 1500, jobLimit: 6 },
    scale: { name: "Scale", priceInr: 29999, slashedPriceInr: null, minutes: 2000, screenings: 5000, jobLimit: null },
  };
  for (const [key, p] of Object.entries(plans)) {
    await db.plan.upsert({
      where: { id: key },
      update: { ...p, key, limits: { roles: p.jobLimit, interviews: p.minutes / 10, interviewMinutes: p.minutes, screenings: p.screenings }, publishedAt: daysAgo(7) },
      create: { id: key, key, version: 1, status: "published", features: {}, ...p, limits: { roles: p.jobLimit, interviews: p.minutes / 10, interviewMinutes: p.minutes, screenings: p.screenings }, publishedAt: daysAgo(7) },
    });
  }
  await db.trialConfig.updateMany({ data: { minutes: 60, days: 14, publishedAt: daysAgo(7) } });
  await db.topupPack.updateMany({ where: { status: "published" }, data: { status: "retired" } });
  for (const [id, kind, quantity, priceInr] of [
    ["demo-pack-100", "minutes", 100, 2999],
    ["demo-pack-250", "minutes", 250, 6499],
    ["demo-pack-500s", "screenings", 500, 1999],
  ]) {
    await db.topupPack.upsert({
      where: { id },
      update: { status: "published" },
      create: { id, kind, quantity, priceInr, validityDays: 90, status: "published", publishedAt: daysAgo(7) },
    });
  }

  // Admins: Gaurav (owner), Deepak (engineer), Sidharth (support, no two step).
  const admins = {};
  for (const [name, email, role] of [
    ["Gaurav", "gaurav@promonkey.tech", "owner"],
    ["Deepak", "deepak@promonkey.tech", "engineer"],
    ["Sidharth", "sidharth@promonkey.tech", "support"],
  ]) {
    admins[role] = await db.adminUser.upsert({
      where: { email },
      update: { name, role, passwordHash: hashPassword(ADMIN_PASSWORD), deactivatedAt: null },
      create: { name, email, role, passwordHash: hashPassword(ADMIN_PASSWORD), lastActiveAt: daysAgo(1) },
    });
  }

  const tenants = {};
  for (const w of WORKSPACES) {
    const plan = await db.plan.findUnique({ where: { id: w.plan } });
    const t = await db.tenant.upsert({
      where: { slug: w.slug },
      update: {},
      create: {
        name: w.name,
        slug: w.slug,
        planId: plan.id,
        status: w.status,
        trialEndsAt: w.status === "trial" ? new Date(Date.now() + 8 * DAY) : null,
        createdAt: daysAgo(w.joined),
      },
    });
    tenants[w.slug] = t;

    for (const [name, email, role] of w.members) {
      const authId = await gotrueUser(email, name);
      await db.user.upsert({
        where: { tenantId_email: { tenantId: t.id, email } },
        update: { authProviderId: authId },
        create: { tenantId: t.id, email, name, role, authProviderId: authId, createdAt: daysAgo(w.joined) },
      });
    }
    if (w.profile) {
      await db.companyProfile.upsert({ where: { tenantId: t.id }, update: w.profile, create: { tenantId: t.id, ...w.profile } });
    }
    const owner = await db.user.findFirst({ where: { tenantId: t.id, role: "owner" } });
    for (const [title, status] of w.jobs ?? []) {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await db.job.upsert({
        where: { tenantId_slug: { tenantId: t.id, slug } },
        update: {},
        create: { tenantId: t.id, slug, title, status, mustHaves: [], goodToHaves: [], createdBy: owner.id },
      });
    }

    const sub = await db.subscription.upsert({
      where: { tenantId: t.id },
      update: {},
      create: {
        tenantId: t.id,
        planId: plan.id,
        status: w.status === "trial" ? "trialing" : w.status === "past_due" ? "past_due" : "active",
        periodStart: daysAgo(Math.min(w.joined, 30)),
        periodEnd: new Date(Date.now() + 2 * DAY),
        createdAt: daysAgo(w.joined),
      },
    });

    await db.usageMeter.upsert({
      where: { tenantId_period: { tenantId: t.id, period } },
      update: { interviewMinutesUsed: w.minutes, screeningsUsed: w.screenings, interviewsUsed: w.interviews },
      create: { tenantId: t.id, period, interviewMinutesUsed: w.minutes, screeningsUsed: w.screenings, interviewsUsed: w.interviews },
    });

    // Fourteen days of history for the minutes chart and the outcomes bar.
    for (let d = 1; d <= 13; d++) {
      const day = new Date(Date.now() - d * DAY);
      const dayKey = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
      const scale = w.minutes / 600;
      await db.usageDaily.upsert({
        where: { tenantId_day: { tenantId: t.id, day: dayKey } },
        update: {},
        create: {
          tenantId: t.id,
          day: dayKey,
          minutes: Math.round((20 + ((d * 37) % 45)) * scale),
          screenings: Math.round((8 + ((d * 13) % 17)) * scale),
          interviews: Math.round((2 + (d % 4)) * scale),
          callsCompleted: Math.round((2 + (d % 4)) * scale),
          callsNoShow: d % 3 === 0 ? 1 : 0,
          callsDropped: d % 5 === 0 ? 1 : 0,
          callsOutOfWindow: d % 7 === 0 ? 1 : 0,
          callsDeclinedConsent: d === 11 ? 1 : 0,
        },
      });
    }
    void sub;
  }

  // Three screened candidates on TechServe's Field Sales role, either side of
  // the suggest threshold, so a change to it visibly moves the Suggested chips.
  const fse = await db.job.findFirst({ where: { tenantId: tenants.techserve.id, slug: "field-sales-executive" } });
  if (fse && (await db.candidate.count({ where: { jobId: fse.id } })) === 0) {
    for (const [name, phone, score] of [["Asha Kulkarni", "+919820011223", 82], ["Vikram Bose", "+919820044556", 74], ["Neha Jain", "+919820077889", 68]]) {
      const c = await db.candidate.create({
        data: { tenantId: tenants.techserve.id, jobId: fse.id, name, email: `${name.split(" ")[0].toLowerCase()}@example.com`, phoneE164: phone, status: "screened", cvParsed: { summary: "demo" } },
      });
      await db.screening.create({
        data: {
          candidateId: c.id, score, matchedMustHaves: ["Field sales"], gaps: [], model: "demo", tokensIn: 0, tokensOut: 0, costUsd: 0,
          verdict: score >= 70 ? "shortlist" : "archive", reasonSummary: `Demo screening at ${score}.`,
        },
      });
    }
  }

  // Ledger.
  const already = await db.payment.count();
  if (already === 0) {
    const pay = (slug, data) => db.payment.create({ data: { tenantId: tenants[slug].id, recordedBy: admins.owner.id, ...data } });
    await pay("techserve", { kind: "subscription", amountPaise: 1299900, method: "upi", status: "captured", description: "Growth monthly", paidAt: daysAgo(31), planId: "growth" });
    await pay("techserve", { kind: "subscription", amountPaise: 800000, method: "upi", status: "captured", description: "Upgrade difference", paidAt: daysAgo(21) });
    await pay("techserve", { kind: "top_up", amountPaise: 299900, method: "card", status: "captured", description: "Top up 100 minutes", paidAt: daysAgo(15), minutes: 100, packId: "demo-pack-100" });
    await pay("dezine", { kind: "subscription", amountPaise: 1299900, method: "upi", status: "captured", description: "Growth monthly", paidAt: daysAgo(4), planId: "growth" });
    await pay("promonkey", { kind: "subscription", amountPaise: 2999900, method: "bank_transfer", status: "captured", description: "Scale monthly", paidAt: daysAgo(19), planId: "scale" });
    await pay("kaya", { kind: "subscription", amountPaise: 499900, method: "card", status: "failed", description: "Starter monthly", paidAt: daysAgo(5), retryAt: new Date(Date.now() + 1 * DAY), reason: "Card declined by issuer", planId: "starter" });
  }

  // FIRSTHIRE at 9 of 50; LAUNCH25 ended.
  await db.coupon.upsert({
    where: { code: "FIRSTHIRE" },
    update: { redeemedCount: 9, maxRedemptions: 50, status: "active", active: true },
    create: { code: "FIRSTHIRE", kind: "percent", value: 20, maxRedemptions: 50, redeemedCount: 9, status: "active", active: true, createdBy: admins.owner.id, createdAt: daysAgo(40) },
  });
  await db.coupon.upsert({
    where: { code: "LAUNCH25" },
    update: {},
    create: { code: "LAUNCH25", kind: "percent", value: 25, maxRedemptions: 18, redeemedCount: 18, status: "ended", active: false, endedAt: daysAgo(33), expiresAt: daysAgo(33), createdAt: daysAgo(90) },
  });
  const firsthire = await db.coupon.findUnique({ where: { code: "FIRSTHIRE" } });
  const techSub = await db.subscription.findUnique({ where: { tenantId: tenants.techserve.id } });
  await db.couponRedemption.upsert({
    where: { couponId_subscriptionId: { couponId: firsthire.id, subscriptionId: techSub.id } },
    update: {},
    create: { couponId: firsthire.id, subscriptionId: techSub.id, discountPaise: 259980, redeemedAt: daysAgo(31) },
  });

  // Strays on the line.
  if ((await db.unknownCall.count()) === 0) {
    const stray = (n, number, code, reason, extra = {}) =>
      db.unknownCall.create({ data: { at: new Date(Date.now() - n * 3_600_000), callerNumber: number, reasonCode: code, reason, ...extra } });
    for (const h of [2, 5, 9]) await stray(h, "+919811044873", "no_match", "No invitation on this number and no reference code given");
    await stray(4, "+919654021188", "not_approved", "Reference code matched TechServe, but the shortlist approval was later withdrawn", { tenantId: tenants.techserve.id });
    for (const h of [20, 22, 25, 27, 30, 33]) await stray(h, "+919004077215", "silent", "Repeated calls, silent line each time");
    for (const h of [40, 51, 70, 90]) await stray(h, `+9198${String(10000000 + h * 7919).slice(0, 8)}`, "no_match", "No invitation on this number and no reference code given");
  }

  // A little history in the log, as the boards show it.
  if ((await db.activityLog.count({ where: { action: { startsWith: "demo." } } })) === 0) {
    const log = (n, data) => db.activityLog.create({ data: { at: new Date(Date.now() - n * 3_600_000), ...data } });
    await log(30, { actorType: "admin", actorId: admins.engineer.id, actorName: "Deepak", action: "workspace.minutes_granted", summary: "Deepak granted 50 goodwill minutes", reason: "onboarding hiccup", targetWorkspaceId: tenants.dezine.id, targetWorkspaceName: "Dezine Labs" });
    await log(26, { actorType: "system", action: "payment.retry_failed", summary: "Payment retry failed, next retry scheduled", targetWorkspaceId: tenants.kaya.id, targetWorkspaceName: "Kaya Wellness" });
    await log(28, { actorType: "admin", actorId: admins.owner.id, actorName: "Gaurav", action: "workspace.plan_changed", summary: "Gaurav changed the plan of TechServe Solutions, Starter to Growth", reason: "customer asked to upgrade", targetWorkspaceId: tenants.techserve.id, targetWorkspaceName: "TechServe Solutions" });
    await log(5, { actorType: "workspace", actorName: "Rohit Sharma", action: "shortlist.approved", summary: "Rohit Sharma approved a shortlist of 4 for Field Sales Executive", targetWorkspaceId: tenants.techserve.id, targetWorkspaceName: "TechServe Solutions" });
    await log(1, { actorType: "system", action: "demo.seeded", summary: "Demo data loaded for local review" });
  }

  console.log(`\nDemo ready.\n  Admin panel  http://localhost:3100  (gaurav@ / deepak@ / sidharth@promonkey.tech, password ${ADMIN_PASSWORD})\n  Portal       http://localhost:3000/techserve  (rohit@techserve.in / ${PORTAL_PASSWORD})\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

