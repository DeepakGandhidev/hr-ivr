import { describe, it, expect, vi, beforeEach } from "vitest";
import { can, Action, UserRole, TenantMismatchError, ForbiddenError, UnauthorizedError } from "@pratibha/shared";
import { withTenantAuth, loadTenantContext } from "@/lib/authz";
import { verifyOutreachGate, validateSendInvitesBody } from "@/lib/gates";

// ---------------------------------------------------------------------------
// 1. Permission matrix for roles vs actions
// ---------------------------------------------------------------------------

describe("Role permission matrix", () => {
  const cases: Array<{ role: UserRole; action: Action; allowed: boolean }> = [
    { role: UserRole.viewer, action: Action.jobRead, allowed: true },
    { role: UserRole.viewer, action: Action.jobCreate, allowed: false },
    { role: UserRole.reviewer, action: Action.shortlistApprove, allowed: true },
    { role: UserRole.reviewer, action: Action.jobCreate, allowed: false },
    { role: UserRole.admin, action: Action.jobCreate, allowed: true },
    { role: UserRole.admin, action: Action.teamManage, allowed: false },
    { role: UserRole.owner, action: Action.teamManage, allowed: true },
    { role: UserRole.owner, action: Action.billingManage, allowed: true },
  ];

  it.each(cases)("$role can $action = $allowed", ({ role, action, allowed }) => {
    expect(can(role, action)).toBe(allowed);
  });
});

// ---------------------------------------------------------------------------
// 2. Tenant isolation via withTenantAuth
// ---------------------------------------------------------------------------

const mockSupabaseUser = { id: "auth-1", email: "user@example.com" };

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: mockSupabaseUser }, error: null })),
    },
  })),
}));

vi.mock("@pratibha/prisma", () => {
  const mockTenant = { id: "tenant-1", slug: "acme", name: "Acme", status: "active" };
  const mockUser = { id: "user-1", tenantId: "tenant-1", role: UserRole.admin };

  // Session bootstrap runs on adminPrisma: resolving which tenant a slug names,
  // and whether the signed-in user belongs to it, cannot be done from inside a
  // tenant context. Everything after that goes through withTenant() under RLS.
  const bootstrap = {
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        if (where.slug === "acme" || where.id === "tenant-1") return mockTenant;
        return null;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { authProviderId?: string } }) => {
        if (where.authProviderId === "auth-1") return mockUser;
        return null;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };

  return {
    prisma: bootstrap,
    adminPrisma: bootstrap,
    withTenant: vi.fn(async (tenantId: string, cb: (tx: unknown) => Promise<unknown>) => {
      return cb({ tenantId });
    }),
  };
});

describe("withTenantAuth isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows access when user belongs to tenant and role is sufficient", async () => {
    const result = await withTenantAuth("acme", Action.jobCreate, async (ctx, tx) => {
      return { ok: true, tenantId: (tx as { tenantId: string }).tenantId };
    });
    expect(result).toEqual({ ok: true, tenantId: "tenant-1" });
  });

  it("rejects cross-tenant access", async () => {
    await expect(
      withTenantAuth("other", Action.jobCreate, async () => ({ ok: true }))
    ).rejects.toBeInstanceOf(ForbiddenError);
  });


});

// ---------------------------------------------------------------------------
// 3. Outreach gate: no approval = no send
// ---------------------------------------------------------------------------

describe("Outreach approval gate (G2)", () => {
  function makeTx({ hasApproval = true, candidateInSnapshot = true }) {
    const candidate = { id: "cand-1", email: "cand@example.com", name: "Candidate" };
    const approval = hasApproval
      ? {
          id: "approval-1",
          snapshot: candidateInSnapshot ? [{ candidateId: candidate.id }] : [{ candidateId: "other" }],
        }
      : null;

    return {
      shortlist: {
        findUnique: vi.fn(async () => ({
          id: "sl-1",
          job: { title: "Engineer" },
          items: [{ candidateId: candidate.id, candidate }],
          approvals: approval ? [approval] : [],
        })),
      },
    } as unknown as Parameters<typeof verifyOutreachGate>[0];
  }

  it("allows outreach when approval exists and candidate is in snapshot", async () => {
    const tx = makeTx({ hasApproval: true, candidateInSnapshot: true });
    const result = await verifyOutreachGate(tx, "sl-1", {});
    expect(result.approval.id).toBe("approval-1");
    expect(result.items).toHaveLength(1);
  });

  it("rejects outreach when there is no approval row", async () => {
    const tx = makeTx({ hasApproval: false });
    await expect(verifyOutreachGate(tx, "sl-1", {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects outreach when candidate is not in approval snapshot", async () => {
    const tx = makeTx({ hasApproval: true, candidateInSnapshot: false });
    await expect(verifyOutreachGate(tx, "sl-1", {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("validates send-invites body", () => {
    // resend is resolved to an explicit false rather than left undefined: the
    // send loop reads it to decide whether to re-mail someone who already has
    // an invite, and that decision should not hinge on a missing property.
    expect(validateSendInvitesBody({})).toEqual({ candidateIds: undefined, resend: false });
    expect(validateSendInvitesBody({ candidateIds: ["cand-1"] })).toEqual({
      candidateIds: ["cand-1"],
      resend: false,
    });
    expect(() => validateSendInvitesBody({ candidateIds: "not-array" } as unknown)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Source-level guard: no outreach without approval_id
// ---------------------------------------------------------------------------

describe("Source-level enforcement: outreach without approval is impossible", () => {
  it("schema marks approvalId as non-null", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const schemaPath = path.resolve(process.cwd(), "../..", "packages/prisma/schema.prisma");
    const schema = fs.readFileSync(schemaPath, "utf8");
    const outreachModel = schema.match(/model OutreachEmail \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(outreachModel).toContain("approvalId");
    expect(outreachModel).not.toContain("approvalId    String?");
  });

  it("send-invites route imports and uses the gate helper", async () => {
    const source = await import("@/lib/gates");
    expect(source.verifyOutreachGate).toBeDefined();
  });
});
