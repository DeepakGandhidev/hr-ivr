import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { activatePromptVersion } from "@/lib/prompts-admin";

export const runtime = "nodejs";

/** Make a version live: a newer draft, or an older one to roll back to. */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("prompts.edit");
    const input = await parseBody(request, z.object({ note: z.string().trim().max(500).optional() }));
    return activatePromptVersion(admin, params.id, input.note || null);
  });
}
