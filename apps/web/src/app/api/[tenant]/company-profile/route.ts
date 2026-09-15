import { NextRequest } from "next/server";
import {
  Action,
  ValidationError,
  writeAuditLog,
  isValidGstin,
  stateFromGstin,
  GST_STATES,
} from "@pratibha/shared";
import { authorizeTenant, withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";
import { deleteAsset } from "@/lib/storage";

export const runtime = "nodejs";

const profileSchema = z.object({
  legalName: z.string().trim().max(200).nullable().optional(),
  billingAddress: z.string().trim().max(2000).nullable().optional(),
  billingState: z.string().trim().max(100).nullable().optional(),
  gstin: z.string().trim().max(20).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  logoAssetId: z.string().trim().nullable().optional(),
});

/**
 * The workspace's own details.
 *
 * Separate from Interview settings on purpose. The name here is the registered
 * entity that appears on an invoice; the name Pratibha says out loud is scoped
 * per job on the interview protocol. Editing one must not change the other,
 * which is why they are different fields in different sections.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.settingsRead, async (ctx, tx) => {
      const profile = await tx.companyProfile.findUnique({
        where: { tenantId: ctx.tenant.id },
      });

      return {
        // Absent and empty mean the same thing, so a missing row is returned as
        // an empty profile rather than null - the form has one shape either way.
        profile: profile ?? {
          tenantId: ctx.tenant.id,
          legalName: null,
          billingAddress: null,
          billingState: null,
          gstin: null,
          description: null,
          logoAssetId: null,
        },
        /// The spoken name, so the form can point at where it is edited.
        workspaceName: ctx.tenant.name,
        states: GST_STATES,
      };
    })
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = profileSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Invalid company profile", parsed.error.flatten());
    }

    const data = parsed.data;

    // Format only. A well-formed GSTIN can still belong to nobody — only the
    // GST portal knows — so this rejects typos and says no more than that.
    if (data.gstin) {
      const gstin = data.gstin.toUpperCase();
      if (!isValidGstin(gstin)) {
        throw new ValidationError(
          "That GSTIN is not in the right format. It should be 15 characters, e.g. 27AAPFU0939F1ZV."
        );
      }
      data.gstin = gstin;

      // The first two digits of a GSTIN are the state. A GSTIN disagreeing with
      // the billing state means one of them is wrong, and the invoice would
      // then compute the wrong CGST/SGST-versus-IGST split.
      const declared = stateFromGstin(gstin);
      if (declared && data.billingState && declared !== data.billingState) {
        throw new ValidationError(
          `That GSTIN is registered in ${declared}, but the billing state says ${data.billingState}.`
        );
      }
      if (declared && !data.billingState) data.billingState = declared;
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.settingsUpdate);

    return tx(async (db) => {
      // Checked rather than trusted: without this, any asset id in the tenant —
      // or a guessed one — could be pinned as the logo.
      if (data.logoAssetId) {
        const asset = await db.tenantAsset.findUnique({
          where: { id: data.logoAssetId },
          select: { id: true, kind: true },
        });
        if (!asset || asset.kind !== "company_logo") {
          throw new ValidationError("That logo could not be found.");
        }
      }

      const before = await db.companyProfile.findUnique({ where: { tenantId: ctx.tenant.id } });

      const profile = await db.companyProfile.upsert({
        where: { tenantId: ctx.tenant.id },
        update: data,
        create: { tenantId: ctx.tenant.id, ...data },
      });

      // A replaced logo is deleted, row and bytes. Otherwise every re-upload
      // leaves an orphan on disk that nothing points at and nobody can tell is
      // unused.
      if (
        data.logoAssetId !== undefined &&
        before?.logoAssetId &&
        before.logoAssetId !== profile.logoAssetId
      ) {
        await deleteAsset(db, before.logoAssetId);
      }

      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "company_profile.updated",
        entity: "tenant",
        entityId: ctx.tenant.id,
        before: before ? redact(before) : {},
        after: redact(profile),
      });

      return { profile };
    });
  });
}

/** The audit entry records what changed, not a second copy of the prose. */
function redact(profile: Record<string, unknown>) {
  return {
    legalName: profile.legalName ?? null,
    billingState: profile.billingState ?? null,
    gstin: profile.gstin ?? null,
    logoAssetId: profile.logoAssetId ?? null,
    hasAddress: Boolean(profile.billingAddress),
    hasDescription: Boolean(profile.description),
  };
}
