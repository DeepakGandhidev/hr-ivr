import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  PLAN_FEATURES,
  PLAN_FEATURE_KEYS,
  PLAN_LIMITS,
  PLAN_TIERS,
  PLANS,
  planEntitlementsError,
  planFeatureDefault,
  planLimitDefault,
} from "@pratibha/shared";
import { __resetSettingsRuntime, startSettings, type SettingRow } from "@pratibha/shared/settings-runtime";
import { planAllows, planEntitlements, planLimit } from "@/lib/plan-features";
import { planClearsGate } from "@/lib/platform-settings";
import { POST as teamPOST } from "@/app/api/[tenant]/team/route";
import { POST as postsPOST } from "@/app/api/[tenant]/jobs/[id]/posts/route";
import { POST as mailboxPOST } from "@/app/api/[tenant]/email-connections/route";

/**
 * Plan features and limits (admin panel, Plans and pricing).
 *
 * The rule that matters most: a plan published before features were editable
 * has none of the catalogue keys, and must behave exactly as it did - portal
 * posts and interview tuning follow the gate.* platform settings, everything
 * else is on and unlimited.
 */

// Route handlers run against a fake tenant and transaction.
const state: { ctx: any; tx: any } = { ctx: null, tx: null };
vi.mock("@/lib/authz", () => ({
  withTenantAuth: async (_slug: string, _action: unknown, fn: (ctx: unknown, tx: unknown) => unknown) => fn(state.ctx, state.tx),
}));


beforeAll(() => {
  process.env.EMAIL_SECRET_KEY ??= "b".repeat(64);
});
afterEach(() => __resetSettingsRuntime());

function panel(rows: Record<string, unknown>) {
  const load = async (): Promise<SettingRow[]> => Object.entries(rows).map(([key, value]) => ({ key, value }));
  return startSettings({ app: "web", load, intervalMs: 60_000 });
}

/** A plan row as seeded before this change: legacy camelCase features only. */
function legacyPlan(key: "starter" | "growth" | "scale") {
  const c = PLANS[key];
  return {
    key,
    features: { ...c.features },
    limits: { ...c.limits },
    minutes: c.limits.interviewMinutes,
    screenings: c.limits.screenings,
    jobLimit: c.limits.roles,
  };
}

type PlanRow = Omit<ReturnType<typeof legacyPlan>, "features" | "limits"> & { features: object; limits: object };

function tenant(plan: PlanRow, status = "active") {
  return { id: "t1", status, planId: `${plan.key}-v1`, plan, trial: null };
}

describe("catalogue", () => {
  it("has the features and limits the panel edits", () => {
    expect(PLAN_FEATURE_KEYS).toEqual(
      expect.arrayContaining([
        "portal_posts", "interview_tuning", "custom_questions", "auto_route_mailboxes", "email_forwarding",
        "gmail_outlook_signin", "dedicated_number", "api_access", "white_label_emails", "priority_support",
      ])
    );
    expect(PLAN_LIMITS.map((l) => l.key)).toEqual(
      expect.arrayContaining(["jobs", "members", "mailboxes", "interview_minutes", "screenings", "custom_questions_per_job", "cv_uploads_per_month"])
    );
  });

  it("defaults every enforced feature to on and every new limit to unlimited, on every tier", () => {
    for (const tier of PLAN_TIERS) {
      for (const f of PLAN_FEATURES.filter((f) => f.enforced)) expect(planFeatureDefault(f.key, tier)).toBe(true);
      for (const l of PLAN_LIMITS.filter((l) => !("column" in l))) expect(planLimitDefault(l.key, tier)).toBeNull();
    }
  });

  it("marks what nothing checks yet as display only, with the old Scale-only flags", () => {
    const display = PLAN_FEATURES.filter((f) => !f.enforced).map((f) => f.key);
    expect(display.sort()).toEqual(["api_access", "dedicated_number", "priority_support"]);
    expect(planFeatureDefault("dedicated_number", "scale")).toBe(true);
    expect(planFeatureDefault("dedicated_number", "growth")).toBe(false);
    expect(planFeatureDefault("api_access", "starter")).toBe(false);
  });

  it("column limits default to the PLANS fallback figures", () => {
    for (const tier of PLAN_TIERS) {
      expect(planLimitDefault("jobs", tier)).toBe(PLANS[tier].limits.roles);
      expect(planLimitDefault("interview_minutes", tier)).toBe(PLANS[tier].limits.interviewMinutes);
      expect(planLimitDefault("screenings", tier)).toBe(PLANS[tier].limits.screenings);
    }
  });

  it("validates what an admin submits", () => {
    expect(planEntitlementsError({ features: { portal_posts: false }, limits: { members: 5, mailboxes: null } })).toBeNull();
    expect(planEntitlementsError({ features: { nope: true } })).toMatch(/Unknown plan feature/);
    expect(planEntitlementsError({ features: { portal_posts: "yes" } })).toMatch(/on or off/);
    expect(planEntitlementsError({ limits: { jobs: 3 } })).toMatch(/Unknown plan limit/);
    expect(planEntitlementsError({ limits: { members: 2.5 } })).toMatch(/whole number/);
  });
});

describe("backward compatibility: published plans with no saved features", () => {
  it("follows the gate.* settings for portal posts and interview tuning, exactly as planClearsGate did", async () => {
    for (const gates of [{}, { "gate.portal_posts": "growth", "gate.interview_tuning": "scale" }, { "gate.portal_posts": "scale" }]) {
      __resetSettingsRuntime();
      await panel(gates);
      const portalGate = (gates as Record<string, string>)["gate.portal_posts"] ?? "all";
      const tuningGate = (gates as Record<string, string>)["gate.interview_tuning"] ?? "all";
      for (const tier of PLAN_TIERS) {
        const t = tenant(legacyPlan(tier));
        expect(planAllows(t, "portal_posts")).toBe(planClearsGate(tier, portalGate));
        expect(planAllows(t, "interview_tuning")).toBe(planClearsGate(tier, tuningGate));
        // Trial workspaces sit on the Starter row and were gated as Starter.
        expect(planAllows(tenant(legacyPlan(tier), "trial"), "portal_posts")).toBe(planClearsGate(tier, portalGate));
      }
    }
  });

  it("keeps the legacy plans.features.portalPosts=false switch", () => {
    const plan = { ...legacyPlan("scale"), features: { portalPosts: false } };
    expect(planAllows(tenant(plan), "portal_posts")).toBe(false);
  });

  it("leaves every other enforced feature on and every new limit unlimited", () => {
    for (const tier of PLAN_TIERS) {
      const t = tenant(legacyPlan(tier));
      for (const f of PLAN_FEATURES.filter((f) => f.enforced)) expect(planAllows(t, f.key)).toBe(true);
      for (const k of ["members", "mailboxes", "custom_questions_per_job", "cv_uploads_per_month"] as const) {
        expect(planLimit(t, k)).toBeNull();
      }
    }
  });

  it("reads open jobs, minutes and screenings from the columns, and from the trial while trialing", () => {
    const t = tenant(legacyPlan("growth"));
    expect(planLimit(t, "jobs")).toBe(6);
    expect(planLimit(t, "interview_minutes")).toBe(600);
    expect(planLimit(t, "screenings")).toBe(400);
    const trial = { ...tenant(legacyPlan("starter"), "trial"), trial: { minutes: 50, days: 15, screenings: 25, jobLimit: 1 } as any };
    expect(planLimit(trial, "jobs")).toBe(1);
    expect(planLimit(trial, "interview_minutes")).toBe(50);
    expect(planLimit(trial, "screenings")).toBe(25);
  });
});

describe("saved values win", () => {
  it("a saved switch overrides the gate either way", async () => {
    await panel({ "gate.portal_posts": "scale" });
    const on = { ...legacyPlan("starter"), features: { portal_posts: true } };
    expect(planAllows(tenant(on), "portal_posts")).toBe(true);
    const off = { ...legacyPlan("scale"), features: { portalAutoPosting: true, portal_posts: false } };
    expect(planAllows(tenant(off), "portal_posts")).toBe(false);
  });

  it("a saved limit, including unlimited, overrides the default", () => {
    const plan = { ...legacyPlan("starter"), limits: { ...legacyPlan("starter").limits, members: 3, mailboxes: null } };
    const e = planEntitlements(tenant(plan));
    expect(e.limits.members).toBe(3);
    expect(e.limits.mailboxes).toBeNull();
    expect(e.features.custom_questions).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Enforcement in the route handlers
// ---------------------------------------------------------------------------

const req = (url: string, body: unknown) =>
  new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("team invite: members limit", () => {
  const POST = teamPOST;

  it("refuses with 402 at the limit", async () => {
    const created = vi.fn();
    state.ctx = { user: { id: "u1", role: "owner" }, tenant: tenant({ ...legacyPlan("starter"), limits: { members: 2 } }) };
    state.tx = { user: { findUnique: async () => null, count: async () => 2, create: created } };
    const res = await POST(req("http://x/api/acme/team", { email: "a@b.co", role: "viewer" }), { params: { tenant: "acme" } });
    expect(res.status).toBe(402);
    expect((await res.json()).message).toMatch(/allows 2 team members/);
    expect(created).not.toHaveBeenCalled();
  });

  it("invites as before on a plan with no saved limit", async () => {
    state.ctx = { user: { id: "u1", role: "owner" }, tenant: tenant(legacyPlan("starter")) };
    state.tx = { user: { findUnique: async () => null, count: async () => 50, create: async ({ data }: any) => ({ id: "u2", ...data }) } };
    const res = await POST(req("http://x/api/acme/team", { email: "a@b.co", role: "viewer" }), { params: { tenant: "acme" } });
    expect(res.status).toBe(201);
  });
});

describe("portal posts", () => {
  const POST = postsPOST;
  const job = { findFirst: async () => null };

  it("refuses with 403 when the plan switches it off", async () => {
    state.ctx = { user: { id: "u1", role: "owner" }, tenant: tenant({ ...legacyPlan("scale"), features: { portal_posts: false } }) };
    state.tx = { job };
    const res = await POST(req("http://x", { channel: "naukri" }), { params: { tenant: "acme", id: "j1" } });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe("Job portal posts are not included in your plan.");
  });

  it("still follows the platform gate for a plan with no saved switch", async () => {
    await panel({ "gate.portal_posts": "growth" });
    state.tx = { job };
    state.ctx = { user: { id: "u1", role: "owner" }, tenant: tenant(legacyPlan("starter")) };
    expect((await POST(req("http://x", { channel: "naukri" }), { params: { tenant: "acme", id: "j1" } })).status).toBe(403);
    // Past the gate, the request reaches the job lookup (none here: 404).
    state.ctx = { user: { id: "u1", role: "owner" }, tenant: tenant(legacyPlan("growth")) };
    expect((await POST(req("http://x", { channel: "naukri" }), { params: { tenant: "acme", id: "j1" } })).status).toBe(404);
  });
});

describe("mailbox connect", () => {
  const POST = mailboxPOST;
  const body = { provider: "forward_alias", address: "jobs@acme.in", defaultJobId: "j1" };

  function tx(count: number, create = vi.fn(async ({ data }: any) => ({ id: "c1", ...data }))) {
    return { job: { findFirst: async () => ({ id: "j1" }) }, emailConnection: { count: async () => count, create } };
  }

  it("refuses a forwarding address when the plan switches forwarding off", async () => {
    state.ctx = { user: { id: "u1", role: "owner" }, tenant: tenant({ ...legacyPlan("growth"), features: { email_forwarding: false } }) };
    state.tx = tx(0);
    const res = await POST(req("http://x", body), { params: { tenant: "acme" } });
    expect(res.status).toBe(403);
  });

  it("refuses with 402 past the mailbox limit, and connects as before without one", async () => {
    const create = vi.fn(async ({ data }: any) => ({ id: "c1", ...data }));
    state.ctx = { user: { id: "u1", role: "owner" }, tenant: tenant({ ...legacyPlan("growth"), limits: { mailboxes: 1 } }) };
    state.tx = tx(1, create);
    expect((await POST(req("http://x", body), { params: { tenant: "acme" } })).status).toBe(402);
    expect(create).not.toHaveBeenCalled();

    state.ctx = { user: { id: "u1", role: "owner" }, tenant: tenant(legacyPlan("growth")) };
    state.tx = tx(25, create);
    expect((await POST(req("http://x", body), { params: { tenant: "acme" } })).status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
  });
});
