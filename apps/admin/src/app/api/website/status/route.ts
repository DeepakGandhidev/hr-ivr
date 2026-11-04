import { type NextRequest } from "next/server";
import { handle } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { publishStatus } from "@/lib/website/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Polled by the Website page while a publish builds. */
export async function GET(request: NextRequest) {
  return handle(request, async () => {
    await requireAdmin("view");
    const id = request.nextUrl.searchParams.get("id") ?? "";
    return publishStatus(id);
  });
}
