import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { connectWhatsApp } from "@/lib/whatsapp-admin";

export const runtime = "nodejs";

const body = z.object({
  phoneNumberId: z.string().trim().min(1).max(40),
  wabaId: z.string().trim().min(1).max(40),
  token: z.string().trim().min(1).max(4000),
  appSecret: z.string().trim().min(1).max(200),
});

/** Check the token with Meta, then save the connection (secrets sealed). Owner only. */
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("settings.owner");
    return connectWhatsApp(admin, await parseBody(request, body));
  });
}
