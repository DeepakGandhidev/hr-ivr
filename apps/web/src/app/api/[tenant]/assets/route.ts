import { NextRequest, NextResponse } from "next/server";
import { Action, ValidationError, writeAuditLog } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { checkImageUpload, storage, MAX_IMAGE_BYTES } from "@/lib/storage";

export const runtime = "nodejs";

const KINDS = ["company_logo", "user_photo"] as const;
type Kind = (typeof KINDS)[number];

/**
 * Upload a tenant asset — a company logo or a profile photo.
 *
 * One endpoint for both because they are the same operation with different
 * authorisation: a logo is workspace branding and needs settings rights, a
 * photo is your own face and needs only that you are signed in.
 *
 * The row and the bytes are written together, and the row is what the deletion
 * flow walks — a file written to disk with only a path in some column is
 * exactly the kind nobody remembers to delete.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    const kindRaw = String(form?.get("kind") ?? "");

    if (!(KINDS as readonly string[]).includes(kindRaw)) {
      throw new ValidationError("Unknown asset kind");
    }
    const kind = kindRaw as Kind;

    if (!file || typeof file === "string") {
      throw new ValidationError("No file was uploaded");
    }

    // A logo changes what every candidate sees; a photo changes only your own
    // row. Resolved from the session, never from the request body.
    const action = kind === "company_logo" ? Action.settingsUpdate : Action.candidateRead;
    const { ctx, tx } = await authorizeTenant(tenant, action);

    // Read once, cap before buffering the whole thing into memory.
    if (file.size > MAX_IMAGE_BYTES) {
      throw new ValidationError("Images must be 2 MB or smaller.");
    }
    const body = Buffer.from(await file.arrayBuffer());

    const check = checkImageUpload(body, file.type);
    if (!check.ok) throw new ValidationError(check.error ?? "That file cannot be used.");

    const stored = await storage.put({
      tenantId: ctx.tenant.id,
      prefix: kind,
      body,
      contentType: file.type,
    });

    return tx(async (db) => {
      const asset = await db.tenantAsset.create({
        data: {
          tenantId: ctx.tenant.id,
          kind,
          storageKey: stored.key,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          uploadedBy: ctx.user.id,
        },
        select: { id: true, kind: true, contentType: true, byteSize: true, createdAt: true },
      });

      await writeAuditLog(db, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "asset.uploaded",
        entity: "tenant_asset",
        entityId: asset.id,
        after: { kind, byteSize: asset.byteSize, contentType: asset.contentType },
      });

      return NextResponse.json({ asset }, { status: 201 });
    });
  });
}
