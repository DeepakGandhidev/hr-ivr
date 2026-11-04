import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { discardEntry, moveEntry, publishWebsite, removeEntry, retryPublish, saveEntry } from "@/lib/website/store";

export const runtime = "nodejs";

const kind = z.enum(["page", "company", "testimonial", "faq", "post"]);
const key = z.string().min(1).max(60);

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), kind, key: key.optional(), data: z.record(z.unknown()) }),
  z.object({ action: z.literal("remove"), kind, key }),
  z.object({ action: z.literal("discard"), kind, key }),
  z.object({ action: z.literal("move"), kind, key, direction: z.enum(["up", "down"]) }),
  z.object({ action: z.literal("publish") }),
  z.object({ action: z.literal("retry") }),
]);

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const input = await parseBody(request, body);
    const publishing = input.action === "publish" || input.action === "retry";
    const { admin } = await requireAdmin(publishing ? "website.publish" : "website.edit");
    switch (input.action) {
      case "save":
        return saveEntry(admin, { kind: input.kind, key: input.key, data: input.data });
      case "remove":
        return removeEntry(admin, input.kind, input.key);
      case "discard":
        return discardEntry(admin, input.kind, input.key);
      case "move":
        return moveEntry(admin, input.kind, input.key, input.direction);
      case "publish":
        return publishWebsite(admin);
      case "retry":
        return retryPublish(admin);
    }
  });
}
