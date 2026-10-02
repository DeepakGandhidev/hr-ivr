#!/usr/bin/env node
/**
 * Create the first Owner, from the server console.
 *
 *   npm run create-owner -w apps/admin -- --name "Gaurav" --email gaurav@promonkey.tech
 *
 * Prints a one-time invite link (72 hours). The Owner opens it, sets a
 * password and turns on two step verification; everyone after that is invited
 * from Admin team inside the panel.
 *
 * With --password-stdin the password is read from standard input instead and
 * the Owner can sign in straight away (they set up two step at first sign in).
 *
 * Refuses while an active Owner exists, unless --recovery is given (every
 * Owner locked out). Either way the act is written to the activity log as a
 * system event, because creating an Owner is as sensitive as it gets.
 */
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@pratibha/prisma";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const name = arg("name");
const email = arg("email")?.trim().toLowerCase();
const recovery = args.includes("--recovery");
const passwordFromStdin = args.includes("--password-stdin");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** The same scrypt format the app verifies (src/lib/auth/password.ts). */
function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", 16384, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
}
const baseUrl = (process.env.ADMIN_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");

if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: create-owner --name "Name" --email person@example.com [--recovery]');
  process.exit(1);
}

const url = process.env.ADMIN_APP_DATABASE_URL ?? process.env.DATABASE_URL;
const db = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);

try {
  const owners = await db.adminUser.count({ where: { role: "owner", deactivatedAt: null } });
  if (owners > 0 && !recovery) {
    console.error(`There is already an active Owner. Invite admins from Admin team, or pass --recovery.`);
    process.exit(2);
  }

  const password = passwordFromStdin ? await readStdin() : null;
  if (passwordFromStdin && (!password || password.length < 12)) {
    console.error("The password must be at least 12 characters.");
    process.exit(1);
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = password ? null : createHash("sha256").update(token).digest("hex");
  const inviteExpiresAt = password ? null : new Date(Date.now() + 72 * 3600_000);
  const passwordHash = password ? hashPassword(password) : undefined;

  const existing = await db.adminUser.findUnique({ where: { email } });
  const admin = existing
    ? await db.adminUser.update({
        where: { id: existing.id },
        data: { name, role: "owner", inviteTokenHash: tokenHash, inviteExpiresAt, passwordHash, deactivatedAt: null, deactivatedBy: null },
      })
    : await db.adminUser.create({
        data: { name, email, role: "owner", inviteTokenHash: tokenHash, inviteExpiresAt, passwordHash },
      });

  await db.activityLog.create({
    data: {
      actorType: "system",
      action: "admin.owner_created",
      summary: `Owner ${name} (${email}) was created from the server console${recovery ? " in recovery" : ""}`,
      after: { adminId: admin.id, email, recovery },
    },
  });

  if (password) {
    console.log(`\nOwner ${name} <${email}> is ready. Sign in at ${baseUrl}/sign-in and turn on two step verification.\n`);
  } else {
    console.log(`\nOwner ${name} <${email}> is ready.\nOpen this link within 72 hours to set a password:\n\n  ${baseUrl}/invite/${token}\n`);
  }
} finally {
  await db.$disconnect();
}
