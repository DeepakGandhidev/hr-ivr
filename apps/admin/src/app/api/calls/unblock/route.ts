import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { unblockNumber } from "@/lib/calls";

export const runtime = "nodejs";

const schema = z.object({ number: z.string().min(4), reason: z.string().optional() });

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("calls.block");
    const body = await parseBody(request, schema);
    return unblockNumber(admin, body.number, requireReason(body.reason, "unblocking a number"));
  });
}
