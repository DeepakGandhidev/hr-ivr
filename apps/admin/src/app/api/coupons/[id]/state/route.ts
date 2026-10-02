import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { endCoupon, pauseCoupon, resumeCoupon, scheduleCoupon } from "@/lib/coupons";

export const runtime = "nodejs";

const schema = z.object({ to: z.enum(["pause", "resume", "schedule", "end"]), reason: z.string().max(500).optional() });

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("coupons.manage");
    const { to, reason } = await parseBody(request, schema);
    const fn = { pause: pauseCoupon, resume: resumeCoupon, schedule: scheduleCoupon, end: endCoupon }[to];
    return fn(admin, params.id, reason);
  });
}
