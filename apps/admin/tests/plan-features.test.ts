import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Editing what a plan includes goes through the same draft and publish as its
 * price: a draft row one version up, the legacy features kept, an activity
 * entry, and nothing at all when the edit matches what is live.
 */

const store: { live: any; draft: any; activity: any[] } = { live: null, draft: null, activity: [] };

const tx = {
  plan: {
    findFirst: async ({ where }: any) => (where.status === "published" ? store.live : store.draft),
    create: async ({ data }: any) => (store.draft = { id: "d1", ...data }),
    update: async ({ data }: any) => (store.draft = { ...store.draft, ...data }),
    delete: async () => (store.draft = null),
  },
};

vi.mock("@/lib/db", () => ({ db: { $transaction: (fn: (t: unknown) => unknown) => fn(tx) } }));
vi.mock("@/lib/activity", () => ({ recordActivity: async (entry: unknown) => void store.activity.push(entry) }));
vi.mock("@/lib/workspaces", () => ({ PAYING: [], mrrOf: () => 0 }));

const { savePlanDraft, entitlementsOf, mergeFeaturesJson } = await import("@/lib/pricing-admin");

const admin = { id: "a1", name: "Asha" } as any;

/** Growth as seeded: legacy camelCase features, none of the catalogue keys. */
const growth = {
  id: "p-growth-1",
  key: "growth",
  name: "Growth",
  version: 1,
  priceInr: 12999,
  slashedPriceInr: null,
  minutes: 600,
  screenings: 400,
  jobLimit: 6,
  visibility: "public",
  status: "published",
  features: { portalAutoPosting: true, protocolTuning: true },
  limits: { roles: 6, interviews: 60, interviewMinutes: 600, screenings: 400 },
};
const fields = { priceInr: 12999, slashedPriceInr: null, minutes: 600, screenings: 400, jobLimit: 6, visibility: "public" as const };

beforeEach(() => {
  store.live = structuredClone(growth);
  store.draft = null;
  store.activity = [];
});

describe("plan features in the draft flow", () => {
  it("reads nothing saved from a plan published before features were editable", () => {
    expect(entitlementsOf(growth as any)).toEqual({ features: {}, limits: {} });
  });

  it("a price-only edit (old client, no entitlements) carries the features over untouched", async () => {
    await savePlanDraft(admin, "growth", { ...fields, priceInr: 13999 });
    expect(store.draft.features).toEqual(growth.features);
    expect(entitlementsOf(store.draft)).toEqual({ features: {}, limits: {} });
    expect(store.draft.version).toBe(2);
  });

  it("saves switches and limits as a draft, keeping the legacy keys, and records the change", async () => {
    const res = await savePlanDraft(admin, "growth", fields, {
      features: { portal_posts: false, api_access: true },
      limits: { members: 5, mailboxes: null },
    });
    expect(res.draft).toBe(true);
    expect(store.draft.status).toBe("draft");
    expect(store.draft.features).toEqual({ portalAutoPosting: true, protocolTuning: true, portal_posts: false, api_access: true });
    expect(store.draft.limits).toMatchObject({ roles: 6, interviewMinutes: 600, screenings: 400, members: 5, mailboxes: null });
    expect(store.activity).toHaveLength(1);
    expect(store.activity[0].action).toBe("pricing.draft_edited");
    expect(store.activity[0].summary).toMatch(/Job portal posts \(Naukri, LinkedIn\) off/);
    expect(store.activity[0].summary).toMatch(/team members default to 5/);
    expect(store.activity[0].after.features).toEqual({ portal_posts: false, api_access: true });
  });

  it("keeps no draft when the switches match what is live", async () => {
    store.live.features = { ...growth.features, custom_questions: false };
    const res = await savePlanDraft(admin, "growth", fields, { features: { custom_questions: false }, limits: {} });
    expect(res.draft).toBe(false);
    expect(store.draft).toBeNull();
  });

  it("clearing a switch back to default removes the key", () => {
    expect(mergeFeaturesJson({ portalPosts: false, portal_posts: true }, {})).toEqual({ portalPosts: false });
  });

  it("refuses keys and values outside the catalogue", async () => {
    await expect(savePlanDraft(admin, "growth", fields, { features: { teleport: true } as any, limits: {} })).rejects.toThrow(/Unknown plan feature/);
    await expect(savePlanDraft(admin, "growth", fields, { features: {}, limits: { members: -1 } })).rejects.toThrow(/whole number/);
  });
});
