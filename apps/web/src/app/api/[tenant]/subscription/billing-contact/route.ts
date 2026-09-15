import { NextRequest, NextResponse } from "next/server";
import { Action, ValidationError, writeAuditLog } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { getOrCreateSubscription, BILLING_EMAIL_TYPES } from "@/lib/subscription";
import { z } from "zod";

export const runtime = "nodejs";

const contactSchema = z.object({
  email: z.string().trim().email().nullable(),
  prefs: z.record(z.boolean()).optional(),
});

/**
 * The finance contact.
 *
 * An email address, deliberately not a portal account. The person who pays the
 * bills needs the invoice; they do not need to see who applied for a job, and
 * creating a login for them would be the easiest way to give them that by
 * accident. This is the whole reason it is a field rather than a team member
 * with a "billing" role.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = contactSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Invalid billing contact", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.billingManage);

    return tx(async (db) => {
      const subscription = await getOrCreateSubscription(db, ctx.tenant);

      const allowed = BILLING_EMAIL_TYPES.map((t) => t.key) as string[];
      const prefs: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(parsed.data.prefs ?? {})) {
        if (allowed.includes(key) && typeof value === "boolean") prefs[key] = value;
      }

      const updated = await db.subscription.update({
        where: { id: subscription.id },
        data: {
          billingContactEmail: parsed.data.email,
          ...(parsed.data.prefs !== undefined && { billingContactPrefs: prefs }),
        },
        select: { billingContactEmail: true, billingContactPrefs: true },
      });

      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "subscription.billing_contact_changed",
        entity: "subscription",
        entityId: subscription.id,
        before: { email: subscription.billingContactEmail },
        after: { email: updated.billingContactEmail },
      });

      return NextResponse.json({ billingContact: updated, types: BILLING_EMAIL_TYPES });
    });
  });
}
