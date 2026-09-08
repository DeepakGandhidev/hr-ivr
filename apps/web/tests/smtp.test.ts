import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { sealSecret } from "@pratibha/shared/crypto";
import { smtpCandidates } from "@/lib/smtp";
import type { EmailConnection } from "@pratibha/prisma";

/**
 * Sending as the tenant means deriving SMTP settings from what they typed when
 * connecting their mailbox for reading. These pin that derivation, because
 * getting it wrong means their outbound mail silently stops.
 */

const KEY = "a".repeat(64);

beforeAll(() => {
  process.env.EMAIL_SECRET_KEY = KEY;
});

const originalHost = process.env.SMTP_HOST;
const originalPort = process.env.SMTP_PORT;
afterEach(() => {
  if (originalHost === undefined) delete process.env.SMTP_HOST;
  else process.env.SMTP_HOST = originalHost;
  if (originalPort === undefined) delete process.env.SMTP_PORT;
  else process.env.SMTP_PORT = originalPort;
});

function connection(overrides: Partial<EmailConnection> = {}): EmailConnection {
  return {
    id: "conn_1",
    tenantId: "tenant_1",
    provider: "imap",
    address: "hr@acme.test",
    imapHost: "mail.acme.test",
    imapPort: 993,
    imapSecure: true,
    imapUsername: "hr@acme.test",
    imapSecret: sealSecret("s3cret", KEY),
    ...overrides,
  } as unknown as EmailConnection;
}

describe("smtpCandidates", () => {
  it("reuses the IMAP hostname, so connecting a mailbox asks for nothing extra", () => {
    const [first] = smtpCandidates(connection());
    expect(first.host).toBe("mail.acme.test");
    expect(first.user).toBe("hr@acme.test");
    expect(first.from).toBe("hr@acme.test");
  });

  it("decrypts the stored password rather than passing the sealed value", () => {
    // Handing the sealed blob to the SMTP server would be a failed login on
    // every send, and on cPanel hosts a fast route to a locked mailbox.
    expect(smtpCandidates(connection())[0].pass).toBe("s3cret");
  });

  it("tries implicit TLS first, then STARTTLS", () => {
    // Hosts disagree about which they offer and the connect form never asks,
    // so both are attempted rather than making the recruiter guess.
    expect(smtpCandidates(connection()).map((t) => [t.port, t.secure])).toEqual([
      [465, true],
      [587, false],
    ]);
  });

  it("honours an explicit port and stops guessing", () => {
    process.env.SMTP_PORT = "587";
    const targets = smtpCandidates(connection());
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ port: 587, secure: false });
  });

  it("treats an explicit 465 as implicit TLS", () => {
    process.env.SMTP_PORT = "465";
    expect(smtpCandidates(connection())[0].secure).toBe(true);
  });

  it("honours an SMTP host override for split-role mail providers", () => {
    process.env.SMTP_HOST = "smtp.acme.test";
    expect(smtpCandidates(connection())[0].host).toBe("smtp.acme.test");
  });

  it("falls back to the address when no separate username was given", () => {
    expect(smtpCandidates(connection({ imapUsername: null }))[0].user).toBe("hr@acme.test");
  });

  it("offers nothing for a connection with no stored password", () => {
    // OAuth and forward-alias connections hold no credential we can send with;
    // the caller falls back to the shared provider rather than failing.
    expect(smtpCandidates(connection({ imapSecret: null }))).toEqual([]);
    expect(smtpCandidates(connection({ imapHost: null }))).toEqual([]);
  });

  it("refuses a tampered credential instead of sending a garbage login", () => {
    const tampered = connection({ imapSecret: sealSecret("s3cret", KEY).replace(/.$/, "X") });
    expect(() => smtpCandidates(tampered)).toThrow();
  });
});
