import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { signInAs } from "@/lib/workspace-actions";

export const runtime = "nodejs";

const schema = z.object({ reason: z.string().optional(), code: z.string().trim().optional() });

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin, session } = await requireAdmin("workspace.sign_in_as");
    const body = await parseBody(request, schema);
    return signInAs(admin, session, params.id, requireReason(body.reason, "signing in as a workspace"), body.code);
  });
}
