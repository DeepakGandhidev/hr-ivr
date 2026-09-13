import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_STATUSES,
  canAutoAdvance,
  isManualOnlyStatus,
  advanceCandidateStatus,
  setCandidateStatusManually,
} from "@pratibha/shared";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "../..");

describe("candidate status vocabulary", () => {
  it("carries all seven positions", () => {
    expect(CANDIDATE_STATUSES).toEqual([
      "inbox",
      "screened",
      "shortlisted",
      "interviewed",
      "advance_stage",
      "hired",
      "rejected",
    ]);
  });

  it("treats the three judgements as manual only", () => {
    expect(isManualOnlyStatus("advance_stage")).toBe(true);
    expect(isManualOnlyStatus("hired")).toBe(true);
    expect(isManualOnlyStatus("rejected")).toBe(true);
    expect(isManualOnlyStatus("screened")).toBe(false);
  });
});

describe("automatic progression", () => {
  it("moves forward through the automatic positions", () => {
    expect(canAutoAdvance("inbox", "screened")).toBe(true);
    expect(canAutoAdvance("screened", "shortlisted")).toBe(true);
    expect(canAutoAdvance("shortlisted", "interviewed")).toBe(true);
  });

  // A re-screen after a JD edit must not drag someone back down the pipeline.
  it("never moves backwards", () => {
    expect(canAutoAdvance("shortlisted", "screened")).toBe(false);
    expect(canAutoAdvance("interviewed", "screened")).toBe(false);
  });

  // Somebody marked Hired does not become Interviewed again because a report
  // finished writing a minute later.
  it("never overwrites a manual judgement", () => {
    for (const manual of ["advance_stage", "hired", "rejected"] as const) {
      for (const auto of ["screened", "shortlisted", "interviewed"] as const) {
        expect(canAutoAdvance(manual, auto)).toBe(false);
      }
    }
  });

  it("cannot reach a manual status automatically", () => {
    expect(canAutoAdvance("interviewed", "hired")).toBe(false);
    expect(canAutoAdvance("inbox", "rejected")).toBe(false);
  });
});

function fakeDb(current: string) {
  return {
    candidate: {
      findUnique: vi.fn().mockResolvedValue({ status: current }),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

describe("advanceCandidateStatus", () => {
  it("writes the new status and an audit entry naming both ends", async () => {
    const db = fakeDb("inbox");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await advanceCandidateStatus(db as any, {
      tenantId: "t1",
      candidateId: "c1",
      to: "screened",
    });

    expect(db.candidate.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { status: "screened" },
    });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "candidate.status",
          actor: "system",
          before: { status: "inbox" },
          after: { status: "screened" },
        }),
      })
    );
  });

  it("does nothing at all when the move is refused", async () => {
    const db = fakeDb("hired");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await advanceCandidateStatus(db as any, {
      tenantId: "t1",
      candidateId: "c1",
      to: "interviewed",
    });

    expect(result).toBe("hired");
    expect(db.candidate.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("manual status changes", () => {
  // The recruiter is the authority on where someone stands; a field that
  // refuses corrections stops matching reality.
  it("allows any move, including backwards, and records who did it", async () => {
    const db = fakeDb("interviewed");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const change = await setCandidateStatusManually(db as any, {
      tenantId: "t1",
      candidateId: "c1",
      to: "inbox",
      actor: "user-7",
    });

    expect(change).toEqual({ from: "interviewed", to: "inbox" });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actor: "user-7",
          before: { status: "interviewed" },
          after: { status: "inbox" },
        }),
      })
    );
  });
});

/**
 * Gaurav's explicit requirement: "Setting this status must never trigger any
 * outreach to the candidate. Outreach still requires an approvals row."
 *
 * Asserted against the source, because the invariant is about what the status
 * path does NOT do — and the cheapest way for that to regress is somebody
 * adding a convenience call to the approval or outreach helpers here.
 */
describe("status changes cannot bypass the approval gate", () => {
  /**
   * Comments are stripped first. Both files discuss the approval gate at length
   * precisely because staying clear of it is the point, and matching that prose
   * would make this test fail for saying the right thing.
   */
  function code(file: string): string {
    return readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  const statusModule = code(path.join(REPO_ROOT, "packages/shared/src/candidateStatus.ts"));
  const statusRoute = code(
    path.join(APP_ROOT, "src/app/api/[tenant]/candidates/[id]/status/route.ts")
  );

  const forbidden = [
    "approval",
    "Approval",
    "outreachEmail",
    "sendInvite",
    "sendMailbox",
    "notify",
  ];

  it("the status helper touches nothing but the candidate and the audit log", () => {
    for (const token of forbidden) {
      expect(statusModule).not.toContain(token);
    }
    expect(statusModule).toContain("db.candidate.update");
  });

  it("the status endpoint creates no approval and sends no mail", () => {
    for (const token of forbidden) {
      expect(statusRoute).not.toContain(token);
    }
  });

  it("the status endpoint is authorised server-side", () => {
    expect(statusRoute).toContain("authorizeTenant(tenant, Action.candidateStatus)");
  });
});
