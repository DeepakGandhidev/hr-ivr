import { NextRequest } from "next/server";
import { Action } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import {
  currentUsagePeriod,
  interviewLimit,
  interviewMinuteLimit,
  screeningLimit,
} from "@/lib/billing";
import { approximateInterviews, quotaState } from "@pratibha/shared";

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
          interviewMinutesUsed: 0,
          screeningsUsed: 0,
        },
      });

      // The meter alone cannot fill a progress bar - "412 minutes used" means
      // nothing without the ceiling it is measured against.
      const minutes = quotaState(meter.interviewMinutesUsed, interviewMinuteLimit(ctx.tenant));

      return {
        meter,
        limits: {
          interviewMinutes: interviewMinuteLimit(ctx.tenant),
          // Descriptive only: pricing is per minute and nothing is enforced
          // against this. It is here so the UI can say "roughly N interviews".
          interviews: interviewLimit(ctx.tenant),
          screenings: screeningLimit(ctx.tenant),
        },
        minutes: {
          ...minutes,
          approximateInterviewsRemaining:
            minutes.remaining === null ? null : approximateInterviews(minutes.remaining),
        },
        period,
      };
    })
  );
}
