import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { saveSettings } from "@/lib/settings-admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("settings.edit");
    return saveSettings(admin, await parseBody(request, z.record(z.unknown())));
  });
}
