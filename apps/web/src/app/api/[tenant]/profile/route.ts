import { NextRequest } from "next/server";
import {
  Action,
  ValidationError,
  writeAuditLog,
  sanitiseNotificationPrefs,
  TIMEZONES,
  NOTIFICATION_TYPES,
} from "@pratibha/shared";
import { authorizeTenant, withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { deleteAsset } from "@/lib/storage";
import { z } from "zod";

export const runtime = "nodejs";

const profileSchema = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  timezone: z.enum(TIMEZONES).nullable().optional(),
  photoAssetId: z.string().trim().nullable().optional(),
  notificationPrefs: z.record(z.boolean()).optional(),
});

/**
 * The signed-in person's own profile.
 *
 * Separate from Company profile: this is one individual, and every field here
 * is theirs alone. Authorisation is therefore "are you signed in to this
 * tenant" rather than any role — a viewer may still change their own name.
 *
 * Email and password are not here. Both are login credentials owned by the auth
 * provider, and both need steps a settings PATCH should not perform quietly:
 * see the sibling `email` and `password` routes.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.candidateRead, async (ctx, tx) => {
      const user = await tx.user.findUnique({
        where: { id: ctx.user.id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          timezone: true,
          photoAssetId: true,
          notificationPrefs: true,
          createdAt: true,
        },
      });

      return {
        user,
        timezones: TIMEZONES,
        notificationTypes: NOTIFICATION_TYPES,
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
      throw new ValidationError("Invalid profile", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateRead);
    const data = parsed.data;

    return tx(async (db) => {
      if (data.photoAssetId) {
        // Checked, not trusted: otherwise any asset id — including another
        // person's photo — could be pinned as your own.
        const asset = await db.tenantAsset.findUnique({
          where: { id: data.photoAssetId },
          select: { id: true, kind: true },
        });
        if (!asset || asset.kind !== "user_photo") {
          throw new ValidationError("That photo could not be found.");
        }
      }

      const before = await db.user.findUnique({
        where: { id: ctx.user.id },
        select: { name: true, timezone: true, photoAssetId: true, notificationPrefs: true },
      });

      const user = await db.user.update({
        where: { id: ctx.user.id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.timezone !== undefined && { timezone: data.timezone }),
          ...(data.photoAssetId !== undefined && { photoAssetId: data.photoAssetId }),
          // Unknown keys are dropped, so the stored object cannot accumulate
          // preferences nothing reads and nobody can clear.
          ...(data.notificationPrefs !== undefined && {
            notificationPrefs: sanitiseNotificationPrefs(data.notificationPrefs),
          }),
        },
        select: {
          id: true,
          name: true,
          email: true,
          timezone: true,
          photoAssetId: true,
          notificationPrefs: true,
        },
      });

      // A replaced photo is deleted, row and bytes, or every re-upload leaves
      // an orphan file nothing points at.
      if (
        data.photoAssetId !== undefined &&
        before?.photoAssetId &&
        before.photoAssetId !== user.photoAssetId
      ) {
        await deleteAsset(db, before.photoAssetId);
      }

      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "user.profile.updated",
        entity: "user",
        entityId: ctx.user.id,
        before: before ?? {},
        after: {
          name: user.name,
          timezone: user.timezone,
          photoAssetId: user.photoAssetId,
          notificationPrefs: user.notificationPrefs,
        },
      });

      return { user };
    });
  });
}
