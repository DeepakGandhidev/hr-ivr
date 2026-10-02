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
