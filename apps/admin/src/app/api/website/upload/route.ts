import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, handle } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { MAX_UPLOAD_BYTES, readUpload, saveUpload } from "@/lib/website/uploads";
import { badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upload one image: the raw bytes as the body (the panel resizes it first). */
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("website.edit");
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_UPLOAD_BYTES) throw badRequest("Images can be up to 1 MB.");
    const buf = Buffer.from(await request.arrayBuffer());
    return saveUpload(admin, buf);
  });
}

/** Show an uploaded image inside the panel, before it is published to the site. */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin("view");
    const { buf, type } = readUpload(request.nextUrl.searchParams.get("file") ?? "");
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
