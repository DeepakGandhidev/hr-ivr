import { randomBytes } from "crypto";
import { NextRequest } from "next/server";
import { Action, emailConnectionSchema, ValidationError } from "@pratibha/shared";
import { sealSecret } from "@pratibha/shared/crypto";
import { inboundDomain, newForwardToken, oauthConfigured } from "@pratibha/shared/mail-oauth";
import type { EmailConnection } from "@pratibha/prisma";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { checkImap, deriveImapDefaults } from "@/lib/imap";
import { redactConnection } from "@/lib/email-connection";
import { assertPlanAllows, assertWithinPlanLimit, planAllows, planLimit } from "@/lib/plan-features";

// ImapFlow is a Node socket client; this route cannot run on the edge runtime.
export const runtime = "nodejs";

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

      return {
        connections: connections.map((c: EmailConnection) => redactConnection(c)),
        jobs,
        // Which sign-in buttons can work on this server, and where forwarded
        // mail is received.
        options: {
          gmailOAuth: oauthConfigured("gmail"),
          outlookOAuth: oauthConfigured("outlook"),
          inboundDomain: inboundDomain(),
        },
        // What the plan includes, so the panel can explain a refusal before it
        // happens. mailboxLimit null is unlimited.
        plan: {
          autoRoute: planAllows(ctx.tenant, "auto_route_mailboxes"),
          forwarding: planAllows(ctx.tenant, "email_forwarding"),
          signIn: planAllows(ctx.tenant, "gmail_outlook_signin"),
          mailboxLimit: planLimit(ctx.tenant, "mailboxes"),
        },
      };
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

      // Gmail and Outlook sign-in goes through the OAuth redirect, which is the
      // only place their tokens are obtained. Gmail with an app password is
      // provider 'imap' against imap.gmail.com.
      if (input.provider === "gmail" || input.provider === "outlook") {
        throw new ValidationError("Use the Sign in button to connect Gmail or Outlook.");
      }

      if (input.provider === "forward_alias") {
        assertPlanAllows(ctx.tenant, "email_forwarding", "Connecting by forwarding address is not included in your plan.");
      }
      if (input.autoRoute) {
        assertPlanAllows(ctx.tenant, "auto_route_mailboxes", "Auto routing is not included in your plan. Choose the one job this mailbox files into.");
      }
      const mailboxes = await tx.emailConnection.count({ where: { tenantId: ctx.tenant.id } });
      assertWithinPlanLimit(ctx.tenant, "mailboxes", mailboxes, 1, (max) =>
        `Your plan allows ${max} connected ${max === 1 ? "mailbox" : "mailboxes"}. Disconnect one or upgrade your plan to add another.`
      );

      let imapData = {};
      let forwardData = {};

      if (input.provider === "forward_alias") {
        forwardData = { forwardToken: newForwardToken(tenant, () => randomBytes(16)) };
      }

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
          ...forwardData,
        },
      });

      return { connection: redactConnection(connection) };
    });
  });
}
