import { NextRequest, NextResponse } from "next/server";
import { adminPrisma } from "@pratibha/prisma";
import { setting } from "@pratibha/shared/settings-runtime";
import { applyWhatsAppWebhook, verifyMetaSignature, type WebhookDb, type WebhookPayload } from "@/lib/whatsapp-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Meta's WhatsApp Cloud API webhook (subscribe the "messages" field).
 *
 * GET is Meta's one-time check when the callback URL is saved: it must echo
 * hub.challenge, and only for the verify token shown on the admin panel's
 * WhatsApp page.
 *
 * POST carries delivery statuses and replies. Public (no session), so the
 * signature is the only thing that makes a body believable: it is checked
 * against the raw bytes before anything is parsed. A STOP reply has to reach
 * every candidate row with that number, in every workspace, so this uses the
 * unscoped client, and only to clear or set the WhatsApp opt-in.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const expected = String(setting<string>("whatsapp.verify_token") ?? "");
  if (params.get("hub.mode") === "subscribe" && expected && params.get("hub.verify_token") === expected) {
    return new NextResponse(params.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(request: NextRequest) {
  const raw = await request.text();
  const appSecret = setting<string | null>("integrations.whatsapp_app_secret");
  if (appSecret) {
    if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"), appSecret)) {
      console.warn("[whatsapp] webhook with a bad or missing signature refused");
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  } else {
    console.warn("[whatsapp] webhook accepted unsigned: no app secret is set (admin panel → WhatsApp)");
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  // Every handler is idempotent, so a fault on our side answers 500 and lets
  // Meta retry: a lost status is harmless, a lost STOP is not.
  try {
    await applyWhatsAppWebhook(adminPrisma as unknown as WebhookDb, payload);
  } catch (err) {
    console.error("[whatsapp] webhook handling failed:", (err as Error).message);
    return NextResponse.json({ error: "temporarily unavailable" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
