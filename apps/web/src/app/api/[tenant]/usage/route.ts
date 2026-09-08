import { NextRequest } from "next/server";
import { Action } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { currentUsagePeriod } from "@/lib/billing";

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.settingsRead, async (ctx, tx) => {
      const period = currentUsagePeriod();
      const meter = await tx.usageMeter.upsert({
        where: { tenantId_period: { tenantId: ctx.tenant.id, period } },
        update: {},
        create: {
          tenantId: ctx.tenant.id,
          period,
          interviewsUsed: 0,
          screeningsUsed: 0,
        },
      });

      return { meter };
    })
  );
}
