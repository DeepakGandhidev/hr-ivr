import { NextRequest } from "next/server";
import { Action, emailConnectionTestSchema, ValidationError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { checkImap, deriveImapDefaults } from "@/lib/imap";

export const runtime = "nodejs";

/**
 * Prove a mailbox's details before anything is saved.
 *
 * Separating this from the save lets someone fix a wrong password without
 * leaving a half-configured connection behind, and it returns the server's
 * folder list so "INBOX" vs "Inbox" vs "INBOX.Applications" stops being a
 * guessing game.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const body = await request.json();
    const parsed = emailConnectionTestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid test payload", parsed.error.flatten());
    }
    const input = parsed.data;

    // Authorised even though nothing is written: this opens an outbound
    // connection using tenant-supplied credentials, so it is not something an
    // unauthenticated caller may trigger.
    return withTenantAuth(tenant, Action.settingsUpdate, async () => {
      const defaults = deriveImapDefaults(input.address);

      const result = await checkImap({
        host: input.imapHost || defaults.host,
        port: input.imapPort ?? defaults.port,
        secure: input.imapSecure ?? (input.imapPort ?? defaults.port) !== 143,
        user: input.imapUsername || input.address,
        pass: input.imapPassword,
        folder: input.folder || defaults.folder,
      });

      // A failed credential check is a normal answer to "are these right?", not
      // a server fault, so it comes back 200 with ok:false and the UI renders
      // the hint inline instead of showing an error page.
      return { result };
    });
  });
}
