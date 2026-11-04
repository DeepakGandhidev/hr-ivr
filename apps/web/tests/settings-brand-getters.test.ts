import { displayNameOf } from "@pratibha/shared/platform-mail";
import { describe, it, expect, afterEach } from "vitest";
import { __resetSettingsRuntime, settingText, startSettings } from "@pratibha/shared/settings-runtime";
import { defaultOutreachTemplates, defaultProtocolInstruction, DEFAULT_OUTREACH_TEMPLATES, DEFAULT_PROTOCOL_INSTRUCTION } from "@pratibha/shared";
import { outreachFromAddress } from "@/lib/email";
import { shortlistSubject } from "@/lib/notifications";
import { TWO_FACTOR_ENABLED, twoFactorEnabled } from "@/lib/features";

/** Start the runtime as if the admin panel had saved `rows`. */
function panel(rows: Record<string, unknown>) {
  return startSettings({
    app: "web",
    load: async () => Object.entries(rows).map(([key, value]) => ({ key, value })),
    intervalMs: 3_600_000,
  });
}

const originalDomain = process.env.RESEND_FROM_DOMAIN;
const originalFrom = process.env.RESEND_FROM_EMAIL;

afterEach(() => {
  __resetSettingsRuntime();
  if (originalDomain === undefined) delete process.env.RESEND_FROM_DOMAIN;
  else process.env.RESEND_FROM_DOMAIN = originalDomain;
  if (originalFrom === undefined) delete process.env.RESEND_FROM_EMAIL;
  else process.env.RESEND_FROM_EMAIL = originalFrom;
});

describe("sender", () => {
  it("is the company via the product when nothing is saved", async () => {
    await panel({});
    expect(displayNameOf(outreachFromAddress("acme", "Acme Corp"))).toBe("Acme Corp via Pratibha");
  });

  it("follows the panel's sender name", async () => {
    await panel({ "messages.sender_name": "Hirebot" });
    expect(displayNameOf(outreachFromAddress("acme", "Acme Corp"))).toBe("Acme Corp via Hirebot");
  });
});

describe("shortlist subject", () => {
  const input = { candidateName: "Asha Rao", jobTitle: "Backend Engineer" };

  it("keeps the built-in wording when empty", async () => {
    await panel({});
    expect(shortlistSubject(input)).toBe("Asha Rao cleared screening for Backend Engineer");
  });

  it("fills in the placeholders", async () => {
    await panel({ "messages.shortlist_subject": "{count} new for {job}: {candidate}" });
    expect(shortlistSubject(input)).toBe("1 new for Backend Engineer: Asha Rao");
  });
});

describe("new-workspace defaults", () => {
  it("are the built-in templates when nothing is saved", async () => {
    await panel({});
    expect(defaultOutreachTemplates(settingText)).toEqual(DEFAULT_OUTREACH_TEMPLATES);
    expect(defaultProtocolInstruction(settingText)).toBe(DEFAULT_PROTOCOL_INSTRUCTION);
  });

  it("replace only what the panel set", async () => {
    await panel({ "messages.invite_subject": "Talk to us about {{jobTitle}}", "messages.protocol_instruction": "Be brief." });
    const [invite, rejection] = defaultOutreachTemplates(settingText);
    expect(invite.subject).toBe("Talk to us about {{jobTitle}}");
    expect(invite.bodyMd).toBe(DEFAULT_OUTREACH_TEMPLATES[0].bodyMd);
    expect(rejection).toEqual(DEFAULT_OUTREACH_TEMPLATES[1]);
    expect(defaultProtocolInstruction(settingText)).toBe("Be brief.");
  });
});

describe("two-step verification flag", () => {
  it("is the build's flag until the panel saves one", async () => {
    await panel({});
    expect(twoFactorEnabled()).toBe(TWO_FACTOR_ENABLED);
  });

  it("follows the panel once saved", async () => {
    await panel({ "features.two_factor": true });
    expect(twoFactorEnabled()).toBe(true);
  });
});
