/**
 * What every new workspace starts with, whoever creates it: the portal's own
 * signup or an admin. One copy, so the two cannot drift.
 */
export const DEFAULT_OUTREACH_TEMPLATES = [
  {
    type: "interview_invite" as const,
    subject: "Interview invite from {{companyName}} for {{jobTitle}}",
    bodyMd: `Hi {{candidateName}},

Thank you for applying for {{jobTitle}} at {{companyName}}.

We would like to invite you for a first-round screening interview with Pratibha, our AI hiring assistant.

Please call {{pratibhaNumber}} and use reference code {{referenceCode}} when prompted.

Best regards,
{{companyName}} Hiring Team`,
  },
  {
    type: "rejection" as const,
    subject: "Update on your application for {{jobTitle}}",
    bodyMd: `Hi {{candidateName}},

Thank you for your interest in {{jobTitle}} at {{companyName}}.

After careful review, we have decided not to move forward with your application at this time.

We wish you the best in your search.

Best regards,
{{companyName}} Hiring Team`,
  },
  {
    type: "reminder" as const,
    subject: "Reminder: Your Pratibha interview for {{jobTitle}}",
    bodyMd: `Hi {{candidateName}},

This is a friendly reminder to complete your Pratibha screening interview for {{jobTitle}} at {{companyName}}.

Call {{pratibhaNumber}} and use reference code {{referenceCode}}.

Best regards,
{{companyName}} Hiring Team`,
  },
];

export const DEFAULT_PROTOCOL_INSTRUCTION =
  "Be warm and concise. Ask one question at a time. Do not discuss salary, joining dates, or other candidates. If asked something you cannot answer, say the team will follow up.";

/**
 * Reads a "messages.*" text setting: the saved wording, or `fallback` when
 * none is saved. The portal passes settingText from the settings runtime and
 * the admin panel its own; this module stays free of either, because the
 * package index (and so every client component) imports it.
 */
export type SettingTextReader = (key: string, fallback: string) => string;

const TEMPLATE_KEYS = {
  interview_invite: "invite",
  rejection: "rejection",
  reminder: "reminder",
} as const;

/**
 * DEFAULT_OUTREACH_TEMPLATES with whatever the admin panel's "Default
 * templates for new workspaces" replace. Each subject and body falls back on
 * its own, so changing one leaves the rest built-in.
 */
export function defaultOutreachTemplates(text: SettingTextReader) {
  return DEFAULT_OUTREACH_TEMPLATES.map((t) => {
    const prefix = `messages.${TEMPLATE_KEYS[t.type]}`;
    return { ...t, subject: text(`${prefix}_subject`, t.subject), bodyMd: text(`${prefix}_body`, t.bodyMd) };
  });
}

/** DEFAULT_PROTOCOL_INSTRUCTION, unless the admin panel has set another. */
export function defaultProtocolInstruction(text: SettingTextReader): string {
  return text("messages.protocol_instruction", DEFAULT_PROTOCOL_INSTRUCTION);
}
