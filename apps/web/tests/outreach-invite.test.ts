import { describe, it, expect } from "vitest";
import { ForbiddenError, NotFoundError, ValidationError } from "@pratibha/shared";
import { validateSendInvitesBody, verifyOutreachGate } from "@/lib/gates";

/**
 * The "Request interview" button is the only thing in the product that mails a
 * candidate, and §6 puts a human approval gate in front of it. These cover the
 * gate itself and the payload it trusts.
 *
 * The denial branch writes its audit entry on a separate connection so the log
 * survives the rollback. That write is guarded, so a denial still surfaces as a
 * 403 with no database here — which is the behaviour these tests pin.
 */

const ACTOR = { tenantId: "tenant_1", userId: "user_1" };

function gateClient(shortlist: unknown) {
  return {
    shortlist: { findUnique: async () => shortlist },
  } as unknown as Parameters<typeof verifyOutreachGate>[0];
}

function candidate(id: string) {
  return { candidateId: id, candidate: { id, email: `${id}@example.com`, name: id } };
}

describe("validateSendInvitesBody", () => {
  it("defaults resend to false, so a repeat click cannot re-mail a candidate", () => {
    expect(validateSendInvitesBody({})).toEqual({ candidateIds: undefined, resend: false });
  });

  it("accepts an explicit resend", () => {
    expect(validateSendInvitesBody({ resend: true }).resend).toBe(true);
  });

  it("treats any non-true value as no resend rather than coercing it", () => {
    // A truthy string from a hand-written client must not silently re-mail.
    expect(() => validateSendInvitesBody({ resend: "yes" })).toThrow(ValidationError);
  });

  it("keeps an explicit candidate list", () => {
    expect(validateSendInvitesBody({ candidateIds: ["c1", "c2"] }).candidateIds).toEqual(["c1", "c2"]);
  });

  it("rejects a candidateIds value that is not an array", () => {
    expect(() => validateSendInvitesBody({ candidateIds: "c1" })).toThrow(ValidationError);
  });

  it("rejects a non-object body", () => {
    expect(() => validateSendInvitesBody(null)).toThrow(ValidationError);
    expect(() => validateSendInvitesBody("send")).toThrow(ValidationError);
  });
});

describe("verifyOutreachGate — §6 approval gate", () => {
  it("refuses to send when the shortlist has never been approved", async () => {
    const shortlist = {
      id: "sl_1",
      job: { title: "Backend Engineer" },
      items: [candidate("c1")],
      approvals: [],
    };

    await expect(
      verifyOutreachGate(gateClient(shortlist), "sl_1", {}, ACTOR)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reports a missing shortlist as not found", async () => {
    await expect(
      verifyOutreachGate(gateClient(null), "sl_missing", {}, ACTOR)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("sends to everyone in the approval snapshot when no candidates are named", async () => {
    const shortlist = {
      id: "sl_1",
      job: { title: "Backend Engineer" },
      items: [candidate("c1"), candidate("c2")],
      approvals: [
        { id: "ap_1", snapshot: [{ candidateId: "c1" }, { candidateId: "c2" }] },
      ],
    };

    const result = await verifyOutreachGate(gateClient(shortlist), "sl_1", {}, ACTOR);

    expect(result.items.map((i) => i.candidateId)).toEqual(["c1", "c2"]);
    expect(result.approval.id).toBe("ap_1");
  });

  it("narrows to the one candidate named by a per-row Request interview click", async () => {
    const shortlist = {
      id: "sl_1",
      job: { title: "Backend Engineer" },
      items: [candidate("c1"), candidate("c2")],
      approvals: [
        { id: "ap_1", snapshot: [{ candidateId: "c1" }, { candidateId: "c2" }] },
      ],
    };

    const result = await verifyOutreachGate(
      gateClient(shortlist),
      "sl_1",
      { candidateIds: ["c2"] },
      ACTOR
    );

    expect(result.items.map((i) => i.candidateId)).toEqual(["c2"]);
  });

  it("refuses the whole send when a named candidate is on the list but not in the snapshot", async () => {
    // Someone added after approval. Sending to them would be contact without a
    // human decision, which is the one thing the gate exists to stop.
    const shortlist = {
      id: "sl_1",
      job: { title: "Backend Engineer" },
      items: [candidate("c1"), candidate("c_new")],
      approvals: [{ id: "ap_1", snapshot: [{ candidateId: "c1" }] }],
    };

    await expect(
      verifyOutreachGate(gateClient(shortlist), "sl_1", { candidateIds: ["c1", "c_new"] }, ACTOR)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
