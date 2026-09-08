import { NextRequest } from "next/server";
import {
  Action,
  NotFoundError,
  outreachTemplateSchema,
  ValidationError,
} from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.outreachTemplateRead, async (ctx, tx) => {
      const templates = await tx.outreachTemplate.findMany({
        where: { tenantId: ctx.tenant.id },
        orderBy: { type: "asc" },
      });
      return { templates };
    })
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const body = await request.json();
    const parsed = outreachTemplateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid outreach template payload", parsed.error.flatten());
    }

    return withTenantAuth(tenant, Action.outreachTemplateUpdate, async (ctx, tx) => {
      const existing = await tx.outreachTemplate.findFirst({
        where: { tenantId: ctx.tenant.id, type: parsed.data.type },
      });

      if (!existing) {
        throw new NotFoundError("Outreach template not found");
      }

      const template = await tx.outreachTemplate.update({
        where: { id: existing.id },
        data: {
          subject: parsed.data.subject,
          bodyMd: parsed.data.bodyMd,
          updatedBy: ctx.user.id,
        },
      });

      return { template };
    });
  });
}
