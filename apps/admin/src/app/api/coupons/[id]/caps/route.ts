import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { editCaps } from "@/lib/coupons";

export const runtime = "nodejs";

const schema = z.object({ cap: z.number().int().nullable(), expiresAt: z.string().nullable() });

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("coupons.manage");
    const body = await parseBody(request, schema);
    const expiresAt = body.expiresAt ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(body.expiresAt) ? `${body.expiresAt}T00:00:00+05:30` : body.expiresAt) : null;
    return editCaps(admin, params.id, { cap: body.cap, expiresAt });
  });
}
