import { NextRequest } from "next/server";
import {
  Action,
  ValidationError,
  writeAuditLog,
  isValidGstin,
  stateFromGstin,
  isValidPin,
  formatAddress,
  GST_STATES,
} from "@pratibha/shared";
import { authorizeTenant, withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";
import { deleteAsset } from "@/lib/storage";
import { platformSettings } from "@/lib/platform-settings";
import { gstinMismatchWarning } from "@/lib/company-copy";

export const runtime = "nodejs";

// Lengths are generous outer bounds here; the real limits are platform settings
// (DB config), checked below, so they can change without a deploy.
const profileSchema = z.object({
  legalName: z.string().trim().max(1000).nullable().optional(),
  addressLine: z.string().trim().max(2000).nullable().optional(),
  city: z.string().trim().max(1000).nullable().optional(),
  pinCode: z.string().trim().max(20).nullable().optional(),
  billingState: z.string().trim().max(100).nullable().optional(),
  gstin: z.string().trim().max(20).nullable().optional(),
  description: z.string().trim().max(20000).nullable().optional(),
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
      const [profile, settings] = await Promise.all([
        tx.companyProfile.findUnique({ where: { tenantId: ctx.tenant.id } }),
        platformSettings(),
      ]);

      return {
        // Absent and empty mean the same thing, so a missing row is returned as
        // an empty profile rather than null - the form has one shape either way.
        profile: profile ?? {
          tenantId: ctx.tenant.id,
          legalName: null,
          billingAddress: null,
          addressLine: null,
          city: null,
          pinCode: null,
          billingState: null,
          gstin: null,
          description: null,
          logoAssetId: null,
        },
        /// The spoken name, so the form can point at where it is edited.
        workspaceName: ctx.tenant.name,
        slug: ctx.tenant.slug,
        states: GST_STATES,
        /// Field limits, from platform settings, so the form and the API agree.
        limits: {
          legalName: settings.legalNameMax,
          addressLine: settings.addressLineMax,
          city: settings.cityMax,
          description: settings.descriptionCap,
          logoBytes: settings.logoMaxBytes,
        },
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
    const settings = await platformSettings();
    const tooLong = (value: string | null | undefined, max: number, what: string) => {
      if (value && value.length > max) throw new ValidationError(`Keep the ${what} under ${max} characters.`);
    };
    tooLong(data.legalName, settings.legalNameMax, "legal company name");
    tooLong(data.addressLine, settings.addressLineMax, "address line");
    tooLong(data.city, settings.cityMax, "city");
    tooLong(data.description, settings.descriptionCap, "company description");

    if (data.billingState && !GST_STATES.some((s) => s.name === data.billingState)) {
      throw new ValidationError("Choose a state from the list.");
    }

    // CP23: six digits, nothing else.
    if (data.pinCode) {
      if (!isValidPin(data.pinCode)) throw new ValidationError("A PIN code is six digits.");
      data.pinCode = data.pinCode.trim();
    }

    // Format blocks saving. A well-formed GSTIN can still belong to nobody (only
    // the GST portal knows), so this rejects typos and says no more than that.
    let warning: string | null = null;
    if (data.gstin) {
      const gstin = data.gstin.toUpperCase();
      if (!isValidGstin(gstin)) {
        throw new ValidationError(
          "That GSTIN is not in the right format. It should be 15 characters, e.g. 07AASFP3808P2ZF."
        );
      }
      data.gstin = gstin;
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

      // The single address block older readers use, kept in step with the parts.
      const merged = {
        addressLine: data.addressLine !== undefined ? data.addressLine : before?.addressLine,
        city: data.city !== undefined ? data.city : before?.city,
        pinCode: data.pinCode !== undefined ? data.pinCode : before?.pinCode,
        state: data.billingState !== undefined ? data.billingState : before?.billingState,
      };
      const addressTouched = ["addressLine", "city", "pinCode", "billingState"].some(
        (k) => (data as Record<string, unknown>)[k] !== undefined
      );
      const write = { ...data, ...(addressTouched ? { billingAddress: formatAddress(merged) } : {}) };

      const profile = await db.companyProfile.upsert({
        where: { tenantId: ctx.tenant.id },
        update: write,
        create: { tenantId: ctx.tenant.id, ...write },
      });

      // A GSTIN whose state code disagrees with the selected state saves (the
      // user must be able to correct either field) but comes back with the
      // persistent warning, because invoices would charge the wrong tax.
      if (profile.gstin && profile.billingState) {
        const declared = stateFromGstin(profile.gstin);
        if (declared && declared !== profile.billingState) {
          warning = gstinMismatchWarning(profile.gstin.slice(0, 2), declared, profile.billingState);
        }
      }

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

      return { profile, warning };
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
    city: profile.city ?? null,
    pinCode: profile.pinCode ?? null,
    hasAddress: Boolean(profile.addressLine || profile.billingAddress),
    hasDescription: Boolean(profile.description),
  };
}
