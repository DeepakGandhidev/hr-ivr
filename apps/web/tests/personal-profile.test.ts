import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  wantsNotification,
  sanitiseNotificationPrefs,
  NOTIFICATION_KEYS,
} from "@pratibha/shared";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(APP_ROOT, p), "utf8");

describe("notification preferences", () => {
  /**
   * Absent means on. A notification type added later must reach people rather
   * than arrive silently disabled for everyone who has ever saved preferences —
   * that failure is invisible, and the first you hear of it is a customer
   * saying they were never told.
   */
  it("treats an unset preference as on", () => {
    expect(wantsNotification(null, "report_ready")).toBe(true);
    expect(wantsNotification({}, "report_ready")).toBe(true);
    expect(wantsNotification({ shortlist_ready: false }, "report_ready")).toBe(true);
  });

  it("respects one that was switched off", () => {
    expect(wantsNotification({ report_ready: false }, "report_ready")).toBe(false);
  });

  it("keeps only known keys", () => {
    const cleaned = sanitiseNotificationPrefs({
      report_ready: false,
      not_a_real_type: true,
      quota_warning: "yes",
    });
    expect(cleaned).toEqual({ report_ready: false });
    expect(Object.keys(cleaned).every((k) => NOTIFICATION_KEYS.includes(k as never))).toBe(true);
  });
});

/**
 * Changing a password is a credential change, and the three things around it
 * are what make it one.
 */
describe("password change", () => {
  const route = read("src/app/api/[tenant]/profile/password/route.ts");

  it("verifies the current password before changing anything", () => {
    const reauth = route.indexOf("signInWithPassword");
    const update = route.indexOf("updateUser({");
    expect(reauth).toBeGreaterThan(-1);
    expect(reauth).toBeLessThan(update);
  });

  // The reason people change a password is that they think someone else has
  // it. Leaving that someone signed in defeats the exercise.
  it("ends every other session", () => {
    expect(route).toContain('signOut({ scope: "others" })');
  });

  it("notifies the account", () => {
    expect(route).toContain("sendEmail");
    expect(route).toContain("password was changed");
  });

  // The notification must not be able to undo a change that already happened.
  it("sends the notification after the change, not before", () => {
    // The call site, not the import at the top of the file.
    expect(route.indexOf("updateUser({")).toBeLessThan(route.indexOf("await sendEmail("));
  });
});

describe("email change", () => {
  const route = read("src/app/api/[tenant]/profile/email/route.ts");

  it("requires the current password", () => {
    expect(route).toContain("signInWithPassword");
  });

  /**
   * Our users row must not be updated until the new address is confirmed —
   * otherwise the app shows an address the person cannot sign in with, and if
   * they never confirm there is no way back.
   */
  it("does not write the new address to our own row", () => {
    expect(route).not.toContain("db.user.update");
    expect(route).not.toContain("tx.user.update");
  });

  it("warns the old address, which is the one a thief moves away from", () => {
    expect(route).toContain("to: ctx.user.email");
  });
});

describe("sessions", () => {
  const route = read("src/app/api/[tenant]/profile/sessions/route.ts");

  // auth.sessions is GoTrue's schema: outside Prisma's models and outside our
  // RLS policies, so the query has to be pinned to this user's own auth id.
  it("scopes the raw query to the signed-in user", () => {
    expect(route).toContain("WHERE user_id = ${ctx.user.authProviderId}::uuid");
  });

  it("keeps the current session alive when signing out the others", () => {
    expect(route).toContain('signOut({ scope: "others" })');
  });
});

/**
 * Two-factor is GoTrue's (auth.mfa_factors). A second secret in our own table
 * could only be checked by our screens, which an attacker holding the password
 * would simply not visit.
 */
describe("two-factor is not reimplemented locally", () => {
  const schema = readFileSync(
    path.resolve(APP_ROOT, "../../packages/prisma/schema.prisma"),
    "utf8"
  );

  it("stores no TOTP secret of its own", () => {
    expect(schema).not.toContain("twoFactorSecret");
    expect(schema).not.toContain("two_factor_secret");
  });
});
