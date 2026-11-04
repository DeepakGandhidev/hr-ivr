import { type NextRequest } from "next/server";
import { z } from "zod";
import type { PromptTemplateKey } from "@pratibha/prisma";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { promptMeta, savePromptVersion } from "@/lib/prompts-admin";

export const runtime = "nodejs";

const body = z.object({
  body: z.string().max(200_000),
  activate: z.boolean().default(false),
  note: z.string().trim().max(500).optional(),
});

/** Save a new version of one prompt, as a draft or straight to live. */
export async function POST(request: NextRequest, { params }: { params: { key: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("prompts.edit");
    const meta = promptMeta(params.key);
    const input = await parseBody(request, body);
    return savePromptVersion(admin, meta.key as PromptTemplateKey, input.body, input.activate ?? false, input.note || null);
  });
}
