import { settingText } from "@pratibha/shared/settings-runtime";
import { copyText } from "@/lib/copy";

/**
 * Account security emails, worded from the admin panel (Text and emails). The
 * defaults are the exact text the profile routes used to build inline.
 */

export interface BuiltEmail {
  subject: string;
  body: string;
}

function greeting(name: string | null | undefined): string {
  return name ? copyText("copy.email.account.greeting", { name }) : copyText("copy.email.account.greeting_anonymous");
}

/** To the OLD address, when someone asks to move the account to a new one. */
export function emailChangeRequestedEmail(args: { name?: string | null; oldEmail: string; newEmail: string }): BuiltEmail {
  return {
    subject: copyText("copy.email.email_change.subject"),
    body:
      `${greeting(args.name)}\n\n` +
      `${copyText("copy.email.email_change.body", { old_email: args.oldEmail, new_email: args.newEmail })}\n`,
  };
}

/** After a password change, to the account's address. */
export function passwordChangedEmail(args: { name?: string | null; email: string }): BuiltEmail {
  const product = settingText("brand.product_name", "Pratibha");
  return {
    subject: copyText("copy.email.password_changed.subject", { product }),
    body:
      `${greeting(args.name)}\n\n` +
      `${copyText("copy.email.password_changed.body", { product, email: args.email })}\n`,
  };
}
