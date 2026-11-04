import { describe, expect, it } from "vitest";
import {
  assertInWorkspace,
  assertJobStatusChange,
  assertMailboxUpdate,
  assertQuestionBounds,
  assertRemovable,
  assertRoleChange,
  changed,
  checkCompanyProfile,
  gstinWarning,
  planClearsGate,
  planOwnershipTransfer,
  slugProblem,
  tuningChanges,
  type MemberLite,
} from "@/lib/workspace-edit";

const member = (id: string, role: MemberLite["role"], extra: Partial<MemberLite> = {}): MemberLite => ({
  id,
  email: `${id}@acme.in`,
  role,
  removedAt: null,
  authProviderId: `auth-${id}`,
  ...extra,
});

describe("ids from the browser are checked against the workspace in the URL", () => {
  it("a row from another workspace is not found, as if it did not exist", () => {
    expect(() => assertInWorkspace({ tenantId: "other" }, "mine", "job")).toThrow("That job is not in this workspace.");
    expect(() => assertInWorkspace(null, "mine", "mailbox")).toThrow(/mailbox is not in this workspace/);
    expect(assertInWorkspace({ tenantId: "mine", id: "j1" }, "mine", "job").id).toBe("j1");
  });
});

describe("the workspace address", () => {
  it("follows the Create workspace rule", () => {
    expect(slugProblem("acme-hr")).toBeNull();
    expect(slugProblem("ab")).toMatch(/3 to 40 characters/);
    expect(slugProblem("Acme")).toMatch(/lowercase/);
    expect(slugProblem("a".repeat(41))).toMatch(/3 to 40/);
    expect(slugProblem("-acme")).toMatch(/hyphen/);
  });

  it("cannot take one of the portal's own pages", () => {
    for (const s of ["api", "login", "signup", "careers", "reset-password"]) expect(slugProblem(s)).toMatch(/portal's own pages/);
  });
});

describe("members: exactly one owner, never removed", () => {
  const team = [member("o", "owner"), member("a", "admin"), member("v", "viewer", { authProviderId: null }), member("gone", "admin", { removedAt: new Date() })];

  it("the owner cannot be removed, anyone else can", () => {
    expect(() => assertRemovable(team, "o")).toThrow(/Transfer ownership/);
    expect(assertRemovable(team, "a").id).toBe("a");
  });

  it("a removed member or one from elsewhere is not found", () => {
    expect(() => assertRemovable(team, "gone")).toThrow(/not in this workspace/);
    expect(() => assertRoleChange(team, "stranger", "viewer")).toThrow(/not in this workspace/);
  });

  it("role changes never make or unmake the owner", () => {
    expect(() => assertRoleChange(team, "a", "owner")).toThrow(/exactly one owner/);
    expect(() => assertRoleChange(team, "o", "admin")).toThrow(/transferring ownership/);
    expect(() => assertRoleChange(team, "a", "admin")).toThrow(/already Admin/);
    expect(assertRoleChange(team, "a", "reviewer").id).toBe("a");
  });

  it("a transfer leaves one owner, and the old one steps down", () => {
    const plan = planOwnershipTransfer(team, "a");
    expect(plan.target.id).toBe("a");
    expect(plan.demote.map((m) => m.id)).toEqual(["o"]);
  });

  it("collapses a legacy second owner too", () => {
    const plan = planOwnershipTransfer([member("o1", "owner"), member("o2", "owner")], "o2");
    expect(plan.demote.map((m) => m.id)).toEqual(["o1"]);
  });

  it("goes only to someone who has joined, and not to the owner already", () => {
    expect(() => planOwnershipTransfer(team, "v")).toThrow(/has not joined yet/);
    expect(() => planOwnershipTransfer(team, "o")).toThrow(/already the owner/);
  });
});

describe("job status", () => {
  const base = { from: "paused" as const, to: "open" as const, archived: false, hasApprovedDescription: true, activeJobs: 2, jobLimit: 2 };

  it("resuming a paused job does not count against the limit twice", () => {
    expect(() => assertJobStatusChange(base)).not.toThrow();
  });

  it("opening needs an approved description, as publishing does", () => {
    expect(() => assertJobStatusChange({ ...base, hasApprovedDescription: false })).toThrow(/approved description/);
  });

  it("reopening a closed job respects the plan's job limit", () => {
    expect(() => assertJobStatusChange({ ...base, from: "closed" })).toThrow(/Active role limit reached \(2\/2\)/);
    expect(() => assertJobStatusChange({ ...base, from: "closed", jobLimit: null })).not.toThrow();
  });

  it("never goes back to draft, and an archived job is restored first", () => {
    expect(() => assertJobStatusChange({ ...base, to: "draft" })).toThrow(/open, paused or closed/);
    expect(() => assertJobStatusChange({ ...base, archived: true })).toThrow(/Restore it/);
  });
});

describe("mailboxes", () => {
  it("a forwarding address always has a destination job", () => {
    expect(() => assertMailboxUpdate({ provider: "forward_alias" }, { defaultJobId: null })).toThrow(/needs a destination job/);
    expect(() => assertMailboxUpdate({ provider: "forward_alias" }, { autoRoute: true } as never)).not.toThrow();
    expect(() => assertMailboxUpdate({ provider: "gmail" }, { defaultJobId: null })).not.toThrow();
  });
});

describe("company profile, with the portal's rules", () => {
  const limits = { legalName: 200, addressLine: 300, city: 100, description: 600 };

  it("cleans blanks to null and upper-cases the GSTIN", () => {
    const out = checkCompanyProfile({ legalName: "  ", gstin: "07aasfp3808p2zf", billingState: "Delhi" }, limits);
    expect(out.legalName).toBeNull();
    expect(out.gstin).toBe("07AASFP3808P2ZF");
  });

  it("refuses what the portal refuses", () => {
    expect(() => checkCompanyProfile({ pinCode: "01234" }, limits)).toThrow("A PIN code is six digits.");
    expect(() => checkCompanyProfile({ gstin: "07AASFP3808" }, limits)).toThrow(/not in the right format/);
    expect(() => checkCompanyProfile({ billingState: "Atlantis" }, limits)).toThrow("Choose a state from the list.");
    expect(() => checkCompanyProfile({ city: "x".repeat(101) }, limits)).toThrow(/under 100 characters/);
  });

  it("warns, without refusing, when the GSTIN's state disagrees", () => {
    expect(gstinWarning("07AASFP3808P2ZF", "Delhi")).toBeNull();
    expect(gstinWarning("07AASFP3808P2ZF", "Karnataka")).toMatch(/starts 07, which is Delhi/);
  });
});

describe("interview settings", () => {
  it("the plan gate matches the portal's", () => {
    expect(planClearsGate("starter", "all")).toBe(true);
    expect(planClearsGate("starter", "growth")).toBe(false);
    expect(planClearsGate("scale", "growth")).toBe(true);
    expect(planClearsGate(undefined, "scale")).toBe(false);
  });

  it("only tuning fields that actually change count against the gate", () => {
    const saved = { difficulty: "moderate", durationMinutes: 10, instructionText: "" };
    expect(tuningChanges(saved, { difficulty: "moderate", durationMinutes: 20, instructionText: "" })).toEqual([]);
    expect(tuningChanges(saved, { difficulty: "hard" })).toEqual(["difficulty"]);
  });

  it("the merged question counts are checked, not just the ones sent", () => {
    expect(() => assertQuestionBounds(8, 6)).toThrow(/cannot be lower/);
    expect(() => assertQuestionBounds(6, 6)).not.toThrow();
  });
});

describe("activity rows keep only what changed", () => {
  it("ignores unchanged and unsent keys", () => {
    expect(changed({ name: "A", slug: "a" }, { name: "A", slug: undefined })).toBeNull();
    expect(changed({ name: "A", slug: "a" }, { slug: "b" })).toEqual({ before: { slug: "a" }, after: { slug: "b" } });
  });
});
