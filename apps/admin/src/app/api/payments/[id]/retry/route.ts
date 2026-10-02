import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { rescheduleRetry } from "@/lib/payments-admin";

export const runtime = "nodejs";

const schema = z.object({ retryOn: z.string().nullable(), reason: z.string().optional() });

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("payments.record");
    const body = await parseBody(request, schema);
    return rescheduleRetry(admin, params.id, body.retryOn, requireReason(body.reason, "changing a retry"));
  });
}
