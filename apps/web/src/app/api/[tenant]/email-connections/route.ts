import { NextRequest } from "next/server";
import { Action, emailConnectionSchema, ValidationError } from "@pratibha/shared";
import { sealSecret } from "@pratibha/shared/crypto";
import type { EmailConnection } from "@pratibha/prisma";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { checkImap, deriveImapDefaults } from "@/lib/imap";
import { redactConnection } from "@/lib/email-connection";

// ImapFlow is a Node socket client; this route cannot run on the edge runtime.
export const runtime = "nodejs";

function buildGmailOAuthUrl(state: string): string | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.settingsRead, async (ctx, tx) => {
      const connections = await tx.emailConnection.findMany({
        where: { tenantId: ctx.tenant.id },
        orderBy: { createdAt: "desc" },
      });

      // The panel shows which job each mailbox files into, so the job titles
      // come back with the connections rather than as a second round trip.
      const jobs = await tx.job.findMany({
        where: { tenantId: ctx.tenant.id, deletedAt: null },
        select: { id: true, title: true, status: true },
        orderBy: { createdAt: "desc" },
      });

      const enriched = connections.map((c: EmailConnection) => ({
        ...redactConnection(c),
        oauthUrl: c.provider === "gmail" ? buildGmailOAuthUrl(c.id) : null,
      }));

      return { connections: enriched, jobs };
    })
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const body = await request.json();
    const parsed = emailConnectionSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid email connection payload", parsed.error.flatten());
    }
    const input = parsed.data;

    return withTenantAuth(tenant, Action.settingsUpdate, async (ctx, tx) => {
      // The destination job is checked inside the tenant transaction, so a
      // caller cannot file candidates into another tenant's job by id.
      if (input.defaultJobId) {
        const job = await tx.job.findFirst({
          where: { id: input.defaultJobId, tenantId: ctx.tenant.id },
        });
        if (!job) throw new ValidationError("defaultJobId does not name a job in this tenant");
      }

      let imapData = {};

      if (input.provider === "imap") {
        const defaults = deriveImapDefaults(input.address);
        const host = input.imapHost || defaults.host;
        const port = input.imapPort ?? defaults.port;
        const secure = input.imapSecure ?? port !== 143;
        const user = input.imapUsername || input.address;
        const folder = input.folder ?? defaults.folder;

        if (!host) throw new ValidationError("Could not work out the IMAP server; enter it manually");

        const check = await checkImap({ host, port, secure, user, pass: input.imapPassword!, folder });
        if (!check.ok) {
          throw new ValidationError(
            check.hint ? `${check.error} — ${check.hint}` : `Could not sign in to ${host}: ${check.error}`
          );
        }

        imapData = {
          imapHost: host,
          imapPort: port,
          imapSecure: secure,
          imapUsername: user,
          imapSecret: sealSecret(input.imapPassword!),
          folder,
        };
      }

      const connection = await tx.emailConnection.create({
        data: {
          tenantId: ctx.tenant.id,
          provider: input.provider,
          address: input.address,
          status: "connected",
          ...(input.defaultJobId && { defaultJobId: input.defaultJobId }),
          ...(input.autoRoute !== undefined && { autoRoute: input.autoRoute }),
          ...imapData,
        },
      });

      return {
        connection: {
          ...redactConnection(connection),
          oauthUrl: connection.provider === "gmail" ? buildGmailOAuthUrl(connection.id) : null,
        },
      };
    });
  });
}
