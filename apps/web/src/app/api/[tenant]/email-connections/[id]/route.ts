import { NextRequest } from "next/server";
import {
  Action,
  emailConnectionUpdateSchema,
  NotFoundError,
  ValidationError,
} from "@pratibha/shared";
import { sealSecret } from "@pratibha/shared/crypto";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { checkImap } from "@/lib/imap";
import { redactConnection } from "@/lib/email-connection";

export const runtime = "nodejs";

/**
 * Edit a saved mailbox: change the password, re-point it at another job, fix
 * the folder, or pause it.
 *
 * Pausing is stored as status 'revoked', which is the state the ingestion
 * poller already skips. It is the difference between "stop reading my inbox
 * right now" and "delete everything you know about it", and an HR user needs
 * the first without losing the second.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const body = await request.json();
    const parsed = emailConnectionUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid email connection update", parsed.error.flatten());
    }
    const input = parsed.data;

    return withTenantAuth(tenant, Action.settingsUpdate, async (ctx, tx) => {
      const existing = await tx.emailConnection.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundError("Email connection not found");
      }

      if (input.defaultJobId) {
        const job = await tx.job.findFirst({
          where: { id: input.defaultJobId, tenantId: ctx.tenant.id },
        });
        if (!job) throw new ValidationError("defaultJobId does not name a job in this tenant");
      }

      const host = input.imapHost ?? existing.imapHost;
      const port = input.imapPort ?? existing.imapPort ?? 993;
      const secure = input.imapSecure ?? existing.imapSecure;
      const user = input.imapUsername ?? existing.imapUsername ?? existing.address;
      const folder = input.folder ?? existing.folder;

      // Re-verify whenever anything that affects the login changes. Saving a
      // bad credential would leave the poller retrying it against a host that
      // locks accounts after repeated failures.
      const loginChanged =
        Boolean(input.imapPassword) ||
        input.imapHost !== undefined ||
        input.imapPort !== undefined ||
        input.imapSecure !== undefined ||
        input.imapUsername !== undefined ||
        input.folder !== undefined;

      if (existing.provider === "imap" && loginChanged) {
        if (!input.imapPassword) {
          // The stored secret could be decrypted and replayed here, but that
          // would mean decrypting a credential to satisfy a settings tweak.
          // Asking for it again keeps the plaintext confined to the one request
          // that genuinely needs it.
          throw new ValidationError(
            "Re-enter the mailbox password to change the server, folder or username."
          );
        }
        if (!host) throw new ValidationError("imapHost is required");

        const check = await checkImap({ host, port, secure, user, pass: input.imapPassword, folder });
        if (!check.ok) {
          throw new ValidationError(
            check.hint ? `${check.error} — ${check.hint}` : `Could not sign in to ${host}: ${check.error}`
          );
        }
      }

      const connection = await tx.emailConnection.update({
        where: { id },
        data: {
          ...(input.imapPassword && { imapSecret: sealSecret(input.imapPassword) }),
          ...(input.imapHost !== undefined && { imapHost: host }),
          ...(input.imapPort !== undefined && { imapPort: port }),
          ...(input.imapSecure !== undefined && { imapSecure: secure }),
          ...(input.imapUsername !== undefined && { imapUsername: user }),
          ...(input.folder !== undefined && { folder }),
          ...(input.defaultJobId !== undefined && { defaultJobId: input.defaultJobId }),
          ...(input.autoRoute !== undefined && { autoRoute: input.autoRoute }),
          ...(input.status !== undefined && { status: input.status }),
          // A successful edit clears a stale failure message, so the panel does
          // not keep showing yesterday's error next to a working mailbox.
          ...(loginChanged && { status: input.status ?? "connected", errorDetail: null }),
        },
      });

      return { connection: redactConnection(connection) };
    });
  });
}

/**
 * Disconnect a mailbox for good.
 *
 * Candidates already ingested are deliberately left alone — they are the
 * tenant's hiring data, not a by-product of the connection, and deleting a
 * mailbox must not silently empty a pipeline.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.settingsUpdate, async (_ctx, tx) => {
      const existing = await tx.emailConnection.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundError("Email connection not found");
      }

      await tx.emailConnection.delete({ where: { id } });
      return { deleted: true, id };
    })
  );
}
