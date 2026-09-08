import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Action, can, UserRole } from "@pratibha/shared";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routeSource = readFileSync(
  path.join(APP_ROOT, "src/app/api/[tenant]/candidates/[id]/route.ts"),
  "utf8"
);

describe("candidate:update permission", () => {
  it("is available to admins and owners", () => {
    expect(can(UserRole.admin, Action.candidateUpdate)).toBe(true);
    expect(can(UserRole.owner, Action.candidateUpdate)).toBe(true);
  });

  it("is not available to reviewers or viewers", () => {
    // Moving discards a screening and a shortlist placement, which is a bigger
    // action than the read-only roles should be able to take.
    expect(can(UserRole.reviewer, Action.candidateUpdate)).toBe(false);
    expect(can(UserRole.viewer, Action.candidateUpdate)).toBe(false);
  });
});

describe("candidate move endpoint", () => {
  it("clears the shortlist placement tied to the old job", () => {
    // A shortlist belongs to a job. Leaving the item behind would keep the
    // candidate cleared to interview for a role they are no longer on.
    expect(routeSource).toMatch(/shortlistItem\.deleteMany/);
    expect(routeSource).toMatch(/shortlist:\s*\{\s*jobId:\s*candidate\.jobId\s*\}/);
  });

  it("clears screenings scored against the old job's must-haves", () => {
    expect(routeSource).toMatch(/screening\.deleteMany/);
  });

  it("checks the phone-number uniqueness constraint before writing", () => {
    // (tenant, job, phone) is unique; hitting it raw surfaces a P2002 that
    // tells the recruiter nothing about the duplicate already there.
    expect(routeSource).toContain("phoneE164");
    expect(routeSource).toMatch(/already on \$\{job\.title\}|already on /);
  });

  it("records the move, including what was discarded", () => {
    expect(routeSource).toContain("candidate.moved");
    expect(routeSource).toContain("discardedScreenings");
  });

  it("re-marks routing as manual rather than leaving a stale router verdict", () => {
    expect(routeSource).toMatch(/routedBy:\s*"manual"/);
  });

  it("requires the update permission, not merely read", () => {
    expect(routeSource).toContain("Action.candidateUpdate");
  });
});
