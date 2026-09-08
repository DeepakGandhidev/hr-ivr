import { z } from 'zod';

export const createTenantSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/),
  ownerEmail: z.string().email(),
  ownerName: z.string().min(1).max(120).optional(),
  password: z.string().min(8),
});

export const createJobSchema = z.object({
  title: z.string().min(1).max(200),
  location: z.string().max(200).optional(),
  salaryBand: z.string().max(200).optional(),
  experienceRange: z.string().max(200).optional(),
  mustHaves: z.array(z.string()).max(20).default([]),
  goodToHaves: z.array(z.string()).max(20).default([]),
});

export const jobDescriptionSchema = z.object({
  bodyMd: z.string().min(1),
  generatedBy: z.enum(['ai', 'human']).default('human'),
});

export const updateShortlistSchema = z.object({
  candidateId: z.string(),
  action: z.enum(['add', 'remove']),
});

export const approveShortlistSchema = z.object({
  shortlistId: z.string(),
});

export const sendInvitesSchema = z.object({
  shortlistId: z.string(),
  candidateIds: z.array(z.string()).optional(),
});

export const outreachTemplateSchema = z.object({
  type: z.enum(['interview_invite', 'rejection', 'reminder']),
  subject: z.string().min(1).max(300),
  bodyMd: z.string().min(1),
});

export const interviewProtocolSchema = z.object({
  jobId: z.string().optional(),
  instructionText: z.string().min(1).max(20000),
  /** Bounds mirror the database CHECK constraints, so the UI cannot offer a
   *  value the write will reject. */
  durationMinutes: z.coerce.number().int().min(2).max(90).optional(),
  difficulty: z.enum(['easy', 'moderate', 'hard', 'expert']).optional(),
  minQuestions: z.coerce.number().int().min(1).max(40).optional(),
  maxQuestions: z.coerce.number().int().min(1).max(40).optional(),
  focusAreas: z.array(z.string().min(1).max(60)).max(12).optional(),
  agentName: z.string().min(1).max(60).nullable().optional(),
  companyName: z.string().min(1).max(120).nullable().optional(),
}).superRefine((value, ctx) => {
  if (
    value.minQuestions !== undefined &&
    value.maxQuestions !== undefined &&
    value.maxQuestions < value.minQuestions
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxQuestions'],
      message: 'Maximum questions cannot be lower than the minimum',
    });
  }
});

/** Workspace-level settings: what the company is called. */
export const tenantSettingsSchema = z.object({
  name: z.string().min(1).max(120),
});

export const callWindowSchema = z.object({
  timezone: z.string().default('Asia/Kolkata'),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
});

/**
 * IMAP mailboxes (cPanel/webmail, Zoho, Namecheap, any host) need connection
 * details the OAuth providers derive for themselves, so those fields are
 * required for provider 'imap' and rejected for the others.
 */
const imapFields = {
  imapHost: z.string().min(1).max(255).optional(),
  imapPort: z.coerce.number().int().min(1).max(65535).default(993).optional(),
  imapSecure: z.boolean().default(true).optional(),
  imapUsername: z.string().min(1).max(320).optional(),
  imapPassword: z.string().min(1).max(1024).optional(),
  folder: z.string().min(1).max(255).default('INBOX').optional(),
  /** With autoRoute off this is the destination; with it on, the fallback. */
  defaultJobId: z.string().min(1).max(64).optional(),
  /** One mailbox for every open role, matched per application. */
  autoRoute: z.boolean().optional(),
};

export const emailConnectionSchema = z
  .object({
    provider: z.enum(['gmail', 'outlook', 'imap', 'forward_alias']),
    address: z.string().email(),
    ...imapFields,
  })
  .superRefine((value, ctx) => {
    if (value.provider !== 'imap') return;
    for (const field of ['imapHost', 'imapPassword'] as const) {
      if (!value[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required for an IMAP connection`,
        });
      }
    }
  });

/** Test a mailbox from the settings panel without saving anything. */
export const emailConnectionTestSchema = z.object({
  address: z.string().email(),
  imapHost: z.string().min(1).max(255).optional(),
  imapPort: z.coerce.number().int().min(1).max(65535).optional(),
  imapSecure: z.boolean().optional(),
  imapUsername: z.string().min(1).max(320).optional(),
  imapPassword: z.string().min(1).max(1024),
  folder: z.string().min(1).max(255).optional(),
});

/**
 * Editing a saved mailbox. The password is optional because the common edits
 * (re-point at another job, rename the folder, pause it) must not force the
 * user to retype a credential they cannot read back.
 */
export const emailConnectionUpdateSchema = z.object({
  imapPassword: z.string().min(1).max(1024).optional(),
  imapHost: z.string().min(1).max(255).optional(),
  imapPort: z.coerce.number().int().min(1).max(65535).optional(),
  imapSecure: z.boolean().optional(),
  imapUsername: z.string().min(1).max(320).optional(),
  folder: z.string().min(1).max(255).optional(),
  defaultJobId: z.string().min(1).max(64).nullable().optional(),
  autoRoute: z.boolean().optional(),
  /** 'revoked' is how a mailbox is paused: the poller skips it. */
  status: z.enum(['connected', 'revoked']).optional(),
});

/**
 * Adding a candidate by hand, with no CV file — the case where a recruiter has
 * the person's details from a call or a referral and wants them in the pipeline
 * anyway.
 *
 * Every field except the job is optional individually, but a row with none of
 * name, email or phone is not a candidate, so at least one is required. Phone
 * is accepted in whatever shape it was written and normalised to E.164 by the
 * caller, because that is what the CV parser does with the same field.
 */
export const manualCandidateSchema = z
  .object({
    jobId: z.string().min(1).max(64),
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().max(320).optional(),
    phone: z.string().min(1).max(32).optional(),
    /** Free text pasted from a CV or a call note, screened like extracted text. */
    notes: z.string().max(20000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.name && !value.email && !value.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message: 'Give at least a name, an email address or a phone number',
      });
    }
  });
