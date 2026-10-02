import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { changePlan } from "@/lib/workspace-actions";

export const runtime = "nodejs";

const schema = z.object({ reason: z.string().optional(), planKey: z.string().min(1, "Choose a plan.") });

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("workspace.change_plan");
    const body = await parseBody(request, schema);
    return changePlan(admin, params.id, body.planKey, requireReason(body.reason, "a plan change"));
  });
}
