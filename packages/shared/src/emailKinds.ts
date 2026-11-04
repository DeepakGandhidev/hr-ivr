/**
 * Every email Pratibha sends, in one list.
 *
 * The admin panel's Email page shows this list (who gets each email and
 * when), each kind has an on/off switch (`emails.<key>`), and every send is
 * logged under its kind. Plain data, safe for browser bundles.
 *
 * `required` kinds cannot be switched off: without them people cannot get
 * into their account.
 */

export type EmailKindGroup = 'account' | 'team' | 'candidates' | 'billing' | 'admin';

export interface EmailKind {
  key: string;
  group: EmailKindGroup;
  label: string;
  to: string;
  when: string;
  required?: boolean;
}

export const EMAIL_KIND_GROUPS: { id: EmailKindGroup; label: string }[] = [
  { id: 'account', label: 'Account and sign-in' },
  { id: 'team', label: 'Notifications to the hiring team' },
  { id: 'candidates', label: 'Emails to candidates' },
  { id: 'billing', label: 'Billing' },
  { id: 'admin', label: 'Sent by the admin panel' },
];

export const EMAIL_KINDS: EmailKind[] = [
  // Account
  { key: 'auth_signup_confirm', group: 'account', label: 'Confirm your email', to: 'New sign-up', when: 'Someone signs up, or asks for the link again', required: true },
  { key: 'auth_password_reset', group: 'account', label: 'Reset your password', to: 'The member', when: '"Forgot password?" on the login page', required: true },
  { key: 'auth_email_change_confirm', group: 'account', label: 'Confirm your new email address', to: 'The new address', when: 'A member changes their email in My profile', required: true },
  { key: 'account_email_change_notice', group: 'account', label: 'Email change requested', to: 'The old address', when: 'A member changes their email in My profile' },
  { key: 'account_password_changed', group: 'account', label: 'Password changed', to: 'The member', when: 'A member changes their password' },

  // Team
  { key: 'shortlist_ready', group: 'team', label: 'Candidate suggested for the shortlist', to: 'Workspace owners and admins', when: 'A screened CV scores above the threshold' },
  { key: 'report_ready', group: 'team', label: 'Interview report ready', to: 'Workspace owners and admins', when: 'A phone interview finishes and its report is written' },
  { key: 'quota_warning', group: 'team', label: 'Interview minutes running low', to: 'Workspace owners and admins', when: 'Usage passes the warning level, and again when minutes run out' },
  { key: 'weekly_summary', group: 'team', label: 'Weekly summary', to: 'Workspace owners and admins', when: 'Every Monday morning (India time)' },

  // Candidates
  { key: 'candidate_invite', group: 'candidates', label: 'Interview invite', to: 'Candidate', when: 'A recruiter clicks Send invites on a shortlist' },
  { key: 'candidate_direct', group: 'candidates', label: 'Direct email', to: 'Candidate', when: 'A recruiter emails a candidate from their profile' },

  // Billing
  { key: 'invoice_issued', group: 'billing', label: 'New invoice', to: 'Billing contact (else the owner)', when: 'A payment is received and its tax invoice raised' },
  { key: 'payment_failed', group: 'billing', label: 'Payment failed', to: 'Billing contact (else the owner)', when: 'An AutoPay renewal or checkout payment fails' },
  { key: 'plan_changed', group: 'billing', label: 'Plan changed', to: 'Billing contact (else the owner)', when: 'The subscription plan changes' },

  // Admin panel
  { key: 'workspace_ready', group: 'admin', label: 'Your workspace is ready', to: 'New owner', when: 'An admin creates a workspace', required: true },
  { key: 'member_invite', group: 'admin', label: "You've been added to a workspace", to: 'New member', when: 'An admin invites a member', required: true },
  { key: 'member_password_reset', group: 'admin', label: 'Reset your password (from an admin)', to: 'The member', when: 'An admin sends a member a password reset', required: true },
  { key: 'member_change_notice', group: 'admin', label: 'Member changes', to: 'Workspace owner', when: 'An admin resets, removes or changes the role of a member, or transfers ownership' },
  { key: 'admin_invite', group: 'admin', label: 'Admin panel invite', to: 'New admin', when: 'An Owner invites someone to the admin team', required: true },
  { key: 'test', group: 'admin', label: 'Test email', to: 'You', when: 'You click Send a test email', required: true },
];

export const EMAIL_KINDS_BY_KEY: Record<string, EmailKind> = Object.fromEntries(EMAIL_KINDS.map((k) => [k.key, k]));

export const emailKindSettingKey = (kind: string) => `emails.${kind}`;
