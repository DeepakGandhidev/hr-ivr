import { NextRequest, NextResponse } from "next/server";
import { Action, NotFoundError, ValidationError, writeAuditLog } from "@pratibha/shared";
import { adminPrisma, type PrismaClient } from "@pratibha/prisma";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { outreachFromAddress, sendAsTenant, tenantLogoUrl } from "@/lib/email";
import { defaultInterviewInviteVars, renderTemplate } from "@/lib/templates";
import { z } from "zod";

const bodySchema = z.object({
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
});

/**
 * Email one candidate directly, with a subject and body a person typed.
 *
 * This is not a hole in the §6 approval gate. That gate exists so the product
 * cannot contact a candidate on the model's say-so — it requires a human
 * decision before outreach. Here a human is composing and sending the message
 * themselves, which is that decision in its most explicit form. What the gate
 * still owns is the automated path: the interview invite, which continues to
 * require an approved shortlist and its snapshot.
 *
 * The send is recorded in the audit log rather than outreach_emails, because
 * every row in that table is tied to an approval id by a non-null column that
 * the authz suite asserts on. Filing an unapproved send there would break the
 * invariant the gate is checked against; the audit log is where actions that
 * are not approval-scoped belong.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Give the email a subject and a body", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.outreachSend);

    const { candidate, connection } = await tx(async (db) => ({
      candidate: await db.candidate.findUnique({ where: { id }, include: { job: true } }),
      connection: await db.emailConnection.findFirst({
        where: { tenantId: ctx.tenant.id, status: "connected" },
        orderBy: { createdAt: "asc" },
      }),
    }));

    if (!candidate) throw new NotFoundError("Candidate not found");
    if (!candidate.email) {
      throw new ValidationError("This candidate has no email address on file");
    }

    // The same placeholders the outreach templates use, so a recruiter can
    // paste a template in and have it fill out exactly as it would when sent
    // automatically.
    const vars = defaultInterviewInviteVars({
      candidateName: candidate.name ?? "Candidate",
      jobTitle: candidate.job.title,
      companyName: ctx.tenant.name,
      pratibhaNumber: process.env.PRATIBHA_NUMBER ?? "",
      referenceCode: "",
    });

    // The company's logo, if they have set one. Candidate-facing mail is a
    // brand surface; the internal team notifications are not, and do not get it.
    const branding = await adminPrisma.companyProfile.findUnique({
      where: { tenantId: ctx.tenant.id },
      select: { logoAssetId: true },
    });
    const logoUrl = tenantLogoUrl(ctx.tenant.slug, Boolean(branding?.logoAssetId));

    const subject = renderTemplate(parsed.data.subject, vars);
    const body = renderTemplate(parsed.data.body, vars);

    // Outside any transaction: SMTP round trips run well past the 5s
    // interactive-transaction timeout.
    const result = await sendAsTenant(connection, ctx.tenant, {
      to: candidate.email,
      subject,
      body,
      from: outreachFromAddress(ctx.tenant.slug, ctx.tenant.name),
      ...(logoUrl ? { logoUrl } : {}),
      ...(connection?.address ? { replyTo: connection.address } : {}),
    });

    // Written on the unfiltered client for the same reason the authz denials
    // are: it must survive independently of the caller's transaction.
    await writeAuditLog(adminPrisma as unknown as PrismaClient, {
      tenantId: ctx.tenant.id,
      actor: ctx.user.id,
      action: result.ok ? "candidate.email.sent" : "candidate.email.failed",
      entity: "candidate",
      entityId: candidate.id,
      after: {
        to: candidate.email,
        subject,
        via: result.via,
        // The provider's own words. Without these an audit row saying "sent"
        // is unfalsifiable, which is what made "is mail actually going out?"
        // so slow to answer.
        smtpResponse: result.smtpResponse ?? null,
        savedToSent: result.savedToSent ?? null,
      },
      reason: result.ok ? undefined : result.error,
    }).catch((error) => console.error("Failed to audit manual candidate email", error));

    if (!result.ok) {
      return NextResponse.json(
        { error: "EMAIL_FAILED", message: result.error ?? "The email could not be sent" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      sent: true,
      to: candidate.email,
      via: result.via,
      savedToSent: result.savedToSent ?? false,
      /** Tells the recruiter it was only logged, not actually delivered. */
      logOnly: result.via === "log",
    });
  });
}
