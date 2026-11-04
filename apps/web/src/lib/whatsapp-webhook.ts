import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * What Meta's WhatsApp webhook tells us, applied to the database.
 *
 *   statuses[]  sent → delivered → read, or failed: recorded on the
 *               whatsapp_log row with that message id (wamid);
 *   messages[]  a reply of STOP (or UNSUBSCRIBE, STOP ALL) puts the number on
 *               the opt-out list and clears every opt-in it has; START takes
 *               it off again and counts as the candidate asking for updates.
 *
 * Everything else (other replies, media, reactions) is ignored: Pratibha does
 * not hold conversations on WhatsApp.
 */

/** Meta's `X-Hub-Signature-256`: "sha256=" + HMAC-SHA256 of the raw body with the app secret. */
export function verifyMetaSignature(raw: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(raw, "utf8").digest();
  // timingSafeEqual throws on a length mismatch; a wrong length is simply wrong.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface WebhookDb {
  whatsappLog: {
    findUnique(args: { where: { wamid: string }; select: { id: true; status: true } }): Promise<{ id: string; status: string } | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  whatsappOptout: {
    upsert(args: {
      where: { phoneE164: string };
      update: Record<string, unknown>;
      create: { phoneE164: string; source: string };
    }): Promise<unknown>;
    deleteMany(args: { where: { phoneE164: string } }): Promise<unknown>;
  };
  candidate: {
    updateMany(args: { where: { phoneE164: string; whatsappOptIn?: boolean }; data: Record<string, unknown> }): Promise<unknown>;
  };
  user: {
    updateMany(args: { where: { phoneE164: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
}

interface StatusEvent {
  id?: string;
  status?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

interface MessageEvent {
  from?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string } };
}

export interface WebhookPayload {
  object?: string;
  entry?: { changes?: { field?: string; value?: { statuses?: StatusEvent[]; messages?: MessageEvent[] } }[] }[];
}

// Statuses can arrive out of order (a read before its delivered); a later
// arrival of an earlier state must not move the row backwards.
const RANK: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 };

const STOP = /^(stop|stop all|unsubscribe)$/i;
const START = /^start$/i;

/** The words of a reply, whatever kind of message carried them. */
function replyText(m: MessageEvent): string {
  const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? "";
  // The keywords are plain ASCII; "Stop." and " STOP " count too.
  return text.replace(/[^A-Za-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function failureReason(status: StatusEvent): string {
  const e = status.errors?.[0];
  if (!e) return "Meta reported the message as failed";
  const details = e.error_data?.details ?? e.message;
  const head = e.title ?? "Failed";
  return `${head}${details && details !== head ? `: ${details}` : ""}${e.code !== undefined ? ` (code ${e.code})` : ""}`.slice(0, 500);
}

export interface WebhookOutcome {
  statuses: number;
  optedOut: number;
  optedIn: number;
}

export async function applyWhatsAppWebhook(db: WebhookDb, payload: WebhookPayload): Promise<WebhookOutcome> {
  const outcome: WebhookOutcome = { statuses: 0, optedOut: 0, optedIn: 0 };
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      for (const status of value.statuses ?? []) {
        if (!status.id || !status.status) continue;
        const row = await db.whatsappLog.findUnique({ where: { wamid: status.id }, select: { id: true, status: true } });
        if (!row) continue; // Not ours, or sent before the log existed.
        if (status.status === "failed") {
          await db.whatsappLog.update({ where: { id: row.id }, data: { status: "failed", error: failureReason(status) } });
          outcome.statuses += 1;
        } else if (status.status in RANK && row.status !== "failed" && RANK[status.status]! > (RANK[row.status] ?? -1)) {
          await db.whatsappLog.update({ where: { id: row.id }, data: { status: status.status } });
          outcome.statuses += 1;
        }
      }

      for (const message of value.messages ?? []) {
        const digits = String(message.from ?? "").replace(/\D/g, "");
        if (!digits) continue;
        const phoneE164 = `+${digits}`;
        const text = replyText(message);

        if (STOP.test(text)) {
          await db.whatsappOptout.upsert({
            where: { phoneE164 },
            update: {},
            create: { phoneE164, source: `reply: ${text.toUpperCase()}` },
          });
          await db.candidate.updateMany({ where: { phoneE164 }, data: { whatsappOptIn: false } });
          await db.user.updateMany({ where: { phoneE164 }, data: { whatsappOptIn: false } });
          outcome.optedOut += 1;
        } else if (START.test(text)) {
          await db.whatsappOptout.deleteMany({ where: { phoneE164 } });
          // Writing START to Pratibha's number is the candidate asking for
          // updates, so it opts them in. Team members opt in from My profile.
          await db.candidate.updateMany({
            where: { phoneE164, whatsappOptIn: false },
            data: { whatsappOptIn: true, whatsappOptInAt: new Date() },
          });
          outcome.optedIn += 1;
        }
      }
    }
  }
  return outcome;
}
