import { NextRequest, NextResponse } from "next/server";
import { Action, ValidationError, UserRole } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120).optional(),
  role: z.nativeEnum(UserRole),
});

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.teamManage, async (_ctx, tx) => {
      const users = await tx.user.findMany({
        orderBy: { createdAt: "desc" },
        select: { id: true, email: true, name: true, role: true, createdAt: true },
      });
      return { users };
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
    const parsed = inviteSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid invite payload", parsed.error.flatten());
    }

    return withTenantAuth(tenant, Action.teamManage, async (ctx, tx) => {
      // In P0 we do not auto-create Supabase auth users for invites.
      // The invited user must sign up with the same email; we create a placeholder user row.
      const existing = await tx.user.findUnique({
        where: { tenantId_email: { tenantId: ctx.tenant.id, email: parsed.data.email } },
      });
      if (existing) {
        throw new ValidationError("User already exists in this workspace");
      }

      const user = await tx.user.create({
        data: {
          tenantId: ctx.tenant.id,
          email: parsed.data.email,
          name: parsed.data.name,
          role: parsed.data.role,
        },
      });

      return NextResponse.json({ user }, { status: 201 });
    });
  });
}
