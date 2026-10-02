import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { createCoupon } from "@/lib/coupons";

export const runtime = "nodejs";

const schema = z.object({
  code: z.string().min(1, "Enter a code."),
  kind: z.enum(["percent", "amount"]),
  value: z.number().int(),
  applicablePlans: z.array(z.string()).default([]),
  cap: z.number().int().nullable(),
  startsAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  draft: z.boolean().default(false),
});

/** A date input's YYYY-MM-DD means midnight IST that day. */
function istMidnight(d: string | null): Date | null {
  if (!d) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00+05:30` : d);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("coupons.manage");
    const body = await parseBody(request, schema);
    return createCoupon(admin, {
      ...body,
      applicablePlans: body.applicablePlans ?? [],
      draft: body.draft ?? false,
      startsAt: istMidnight(body.startsAt),
      expiresAt: istMidnight(body.expiresAt),
    });
  });
}
