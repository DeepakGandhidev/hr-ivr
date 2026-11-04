import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { sendWhatsAppTest } from "@/lib/whatsapp-admin";

export const runtime = "nodejs";

const body = z.object({ phone: z.string().trim().min(1).max(40), kind: z.string().trim().max(60).optional() });

/** Send one template, with sample values, to the number typed in. */
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    await requireAdmin("settings.edit");
    const { phone, kind } = await parseBody(request, body);
    return sendWhatsAppTest(phone, kind);
  });
}
