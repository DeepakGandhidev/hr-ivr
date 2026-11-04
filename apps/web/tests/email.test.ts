import { describe, it, expect, vi } from "vitest";

// No database in unit tests: the email log is written through this fake.
vi.mock("@pratibha/prisma", () => ({
  adminPrisma: {
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "log1" }),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { displayNameOf } from "@pratibha/shared/platform-mail";
import { outreachFromAddress, sendEmail } from "@/lib/email";

describe("outreachFromAddress", () => {
  it("names the company, sent by Pratibha", () => {
    expect(displayNameOf(outreachFromAddress("acme", "Acme Corp"))).toBe("Acme Corp via Pratibha");
  });

  it("is just the product when the plan does not send in the company's name", () => {
    expect(displayNameOf(outreachFromAddress("acme", "Acme Corp", false))).toBe("Pratibha");
  });
});

describe("sendEmail with no mailbox connected", () => {
  it("does not claim a send, and says where to connect one", async () => {
    const result = await sendEmail({ kind: "test", to: "c@example.test", subject: "s", body: "b" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Email page/);
  });
});
