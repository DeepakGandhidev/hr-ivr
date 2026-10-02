import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { inviteAdmin } from "@/lib/team";

export const runtime = "nodejs";

const schema = z.object({
  name: z.string().trim().min(1, "Name them."),
  email: z.string().trim().email("Enter their email address."),
  role: z.enum(["owner", "engineer", "support"]),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("team.manage");
    return inviteAdmin(admin, await parseBody(request, schema));
  });
}
