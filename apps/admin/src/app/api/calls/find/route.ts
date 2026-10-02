import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { findCandidates } from "@/lib/calls";

export const runtime = "nodejs";

/** Find candidate: every workspace, by number. Read only. */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin("view");
    return NextResponse.json({ matches: await findCandidates(request.nextUrl.searchParams.get("number") ?? "") });
  } catch (error) {
    return errorResponse(error);
  }
}
