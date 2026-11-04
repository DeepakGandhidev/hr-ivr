import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { saveSettings } from "@/lib/settings-admin";

export const runtime = "nodejs";

const body = z.object({
  set: z.record(z.unknown()).optional(),
  reset: z.array(z.string().max(120)).max(500).optional(),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("settings.edit");
    return saveSettings(admin, await parseBody(request, body));
  });
}
