import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { connectMailbox } from "@/lib/email-admin";

export const runtime = "nodejs";

const body = z.object({
  address: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(500),
  host: z.string().trim().max(200).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
});

/** Check the login with the mail server, save it (sealed), and send a test email. Owner only. */
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("settings.owner");
    return connectMailbox(admin, await parseBody(request, body));
  });
}
