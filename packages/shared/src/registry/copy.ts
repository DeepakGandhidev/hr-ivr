import type { SettingDef } from '../settingsRegistry.js';
import { CANDIDATE_STATUSES, CANDIDATE_STATUS_LABELS } from '../candidateStatus.js';

/**
 * Text customers and candidates see (group 'copy'): page wording, system
 * emails, status names. Every entry defaults to the wording the product
 * shipped with, so an empty panel changes nothing.
 *
 * Keys are read by the portal through lib/copy.ts (server) and the copy
 * channel (client); the worker's team emails through its notify/text.js.
 * `{name}` placeholders are filled by the code; the ones each key receives
 * are listed in COPY_VARS and in its help text.
 *
 * `**bold**` is understood only where the help says so (notices that had
 * bold runs in their original wording).
 */

interface CopyItem {
  /** Key suffix under the section's prefix. */
  k: string;
  label: string;
  text: string;
  /** Placeholders the code fills for this key. */
  vars?: string[];
  /** Extra help after the "where it appears" sentence. */
  note?: string;
  /** Force a multi-line field. */
  long?: boolean;
}

/** Placeholders each copy key is given, by key. */
export const COPY_VARS: Record<string, string[]> = {};

function section(name: string, prefix: string, where: string, items: CopyItem[]): SettingDef[] {
  return items.map((item) => {
    const key = `${prefix}.${item.k}`;
    const long = item.long || item.text.length > 110 || item.text.includes('\n');
    if (item.vars?.length) COPY_VARS[key] = item.vars;
    const help = [
      where,
      item.note,
      item.vars?.length ? `Placeholders: ${item.vars.map((v) => `{${v}}`).join(', ')}.` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    return {
      key,
      group: 'copy',
      section: name,
      label: item.label,
      help,
      type: long ? 'textarea' : 'text',
      default: item.text,
      maxLength: long ? 3000 : 300,
      applies: 'live',
      apps: ['web'],
    } satisfies SettingDef;
  });
}

/** Sections the worker sends (and reads) rather than the portal. */
function forWorker(defs: SettingDef[]): SettingDef[] {
  return defs.map((def) => ({ ...def, apps: ['worker'] }));
}

const BOLD = 'Wrap words in **double stars** to show them in bold.';

// ------------------------------------------------------------------ emails
const EMAILS: SettingDef[] = [
  ...section('Email: shortlist ready (to the hiring team)', 'copy.email.shortlist', 'The email owners and admins get when a candidate clears screening. The subject is under Emails and notifications, Team notifications.', [
    { k: 'intro', label: 'Opening line', text: '{candidate} scored {score} against {job} and is now on the draft shortlist.', vars: ['candidate', 'score', 'job'], note: 'The screening summary follows this line.' },
    { k: 'action', label: 'What to do', text: 'They have not been contacted. Approve the shortlist and press Request interview to send them an invite:', note: 'The link to the shortlist follows on the next line.' },
    { k: 'signoff', label: 'Sign-off', text: '— {product}, for {company}', vars: ['product', 'company'] },
  ]),
  ...section('Email: account greeting', 'copy.email.account', 'First line of the account security emails (email change, password changed).', [
    { k: 'greeting', label: 'Greeting with a name', text: 'Hello {name},', vars: ['name'] },
    { k: 'greeting_anonymous', label: 'Greeting without a name', text: 'Hello,' },
  ]),
  ...section('Email: email change requested', 'copy.email.email_change', 'Sent to the old address when someone asks to change the email on an account.', [
    { k: 'subject', label: 'Subject', text: 'A change of email address was requested on your Pratibha account' },
    {
      k: 'body',
      label: 'Body',
      text:
        'Someone asked to change the email address on your Pratibha account from {old_email} to {new_email}. It will not take effect until the new address is confirmed.\n\n' +
        'If this was not you, change your password now and contact your workspace owner.',
      vars: ['old_email', 'new_email'],
      note: 'The greeting is added above it.',
    },
    {
      k: 'approve',
      label: 'Approval link',
      text: 'To approve the change from this address as well, open this link:\n\n{link}',
      vars: ['link'],
      note: 'Added below the body only when the auth service asks both addresses to confirm a change (secure email change).',
    },
  ]),
  ...section('Email: confirm your new email address', 'copy.email.email_change_confirm', 'Sent to the new address when someone changes the email on their account. The change happens when the link is opened.', [
    { k: 'subject', label: 'Subject', text: 'Confirm your new email address for {product}', vars: ['product'] },
    {
      k: 'body',
      label: 'Body',
      text:
        'You asked to move your {product} account from {old_email} to this address, {new_email}. To confirm it, open this link:\n\n{link}\n\n' +
        'Until you do, you keep signing in with {old_email}. If you did not ask for this, ignore this email.',
      vars: ['product', 'old_email', 'new_email', 'link'],
      note: 'The greeting is added above it.',
    },
  ]),
  ...section('Email: confirm your email (sign-up)', 'copy.email.signup_confirm', 'Sent when someone creates a workspace, and again when they ask for a new link.', [
    { k: 'subject', label: 'Subject', text: 'Confirm your email for {product}', vars: ['product'] },
    {
      k: 'body',
      label: 'Body',
      text:
        'Thanks for creating the {workspace} workspace on {product}. To confirm this is your email address and open your workspace, follow this link:\n\n{link}\n\n' +
        'The link works once. If you did not sign up, ignore this email and no account will be activated.',
      vars: ['product', 'workspace', 'link'],
      note: 'The greeting is added above it.',
    },
  ]),
  ...section('Email: reset your password', 'copy.email.password_reset', 'Sent when someone uses "Forgot password?" on the log-in screen.', [
    { k: 'subject', label: 'Subject', text: 'Reset your {product} password', vars: ['product'] },
    {
      k: 'body',
      label: 'Body',
      text:
        'Someone asked to reset the password for {email} on {product}. To choose a new one, open this link:\n\n{link}\n\n' +
        'The link works once and expires soon. If you did not ask for this, ignore this email: your password stays as it is.',
      vars: ['product', 'email', 'link'],
      note: 'The greeting is added above it.',
    },
  ]),
  ...section('Email: password changed', 'copy.email.password_changed', 'Sent after someone changes their password from My profile.', [
    { k: 'subject', label: 'Subject', text: 'Your {product} password was changed', vars: ['product'] },
    {
      k: 'body',
      label: 'Body',
      text:
        'The password on your {product} account ({email}) was just changed, and every other signed-in device was signed out.\n\n' +
        'If this was you, there is nothing to do.\n\n' +
        'If it was not, your account is at risk: reset your password immediately and contact your workspace owner.',
      vars: ['product', 'email'],
      note: 'The greeting is added above it.',
    },
  ]),
  ...forWorker(section('Email: interview report ready (to the hiring team)', 'copy.email.report_ready', 'The email owners and admins get when a phone interview finishes and its report is written.', [
    { k: 'subject', label: 'Subject', text: 'Interview report ready: {candidate} for {job}', vars: ['candidate', 'job'] },
    { k: 'intro', label: 'Opening line', text: '{candidate} has finished their phone interview for {job}, and the report is written.', vars: ['candidate', 'job'] },
    { k: 'score', label: 'Score line', text: 'Overall: {score} out of 10. Recommendation: {recommendation}.', vars: ['score', 'recommendation'], note: 'Left out when the report has no overall score.' },
    { k: 'action', label: 'What to do', text: 'Read the report and the full conversation:', note: 'The link to the candidate follows on the next line.' },
    { k: 'signoff', label: 'Sign-off', text: '— {product}, for {company}', vars: ['product', 'company'] },
  ])),
  ...forWorker(section('Email: interview minutes running low (to the hiring team)', 'copy.email.quota', 'The email owners and admins get when interview minutes pass the warning level (Billing), and again when they run out. Each is sent once a month.', [
    { k: 'warning_subject', label: 'Subject: running low', text: '{company} has used {percent}% of its interview minutes', vars: ['company', 'percent'] },
    { k: 'warning_intro', label: 'Opening line: running low', text: '{company} has used {used} of its {limit} interview minutes this month. {remaining} are left.', vars: ['company', 'used', 'limit', 'remaining'] },
    { k: 'exhausted_subject', label: 'Subject: run out', text: '{company} has used all its interview minutes', vars: ['company'] },
    { k: 'exhausted_intro', label: 'Opening line: run out', text: '{company} has used {used} interview minutes this month, its full allowance of {limit}.', vars: ['company', 'used', 'limit'] },
    { k: 'action', label: 'What to do', text: 'Add minutes or change your plan on the Subscription page:', note: 'The link to the Subscription page follows on the next line.' },
    { k: 'signoff', label: 'Sign-off', text: '— {product}', vars: ['product'] },
  ])),
  ...section('Email: weekly summary (to the hiring team)', 'copy.email.weekly_summary', 'The Monday morning digest owners and admins get about the week just gone (Monday to Sunday).', [
    { k: 'subject', label: 'Subject', text: 'Your week on {product}: {week}', vars: ['product', 'week'] },
    { k: 'intro', label: 'Opening line', text: 'Here is how hiring went at {company} last week ({week}).', vars: ['company', 'week'] },
    {
      k: 'stats',
      label: 'The figures',
      text:
        'New applications: {applications}\n' +
        'Screened: {screened}\n' +
        'Shortlisted: {shortlisted}\n' +
        'Interviews completed: {interviews}\n' +
        'Interview minutes used this month: {minutes_used} of {minutes_allowance}\n' +
        'Open jobs: {open_jobs}',
      vars: ['applications', 'screened', 'shortlisted', 'interviews', 'minutes_used', 'minutes_allowance', 'open_jobs'],
      note: '{minutes_allowance} reads "unlimited" on a plan without a cap.',
    },
    { k: 'action', label: 'Link line', text: 'See everything on your dashboard:', note: 'The link to the dashboard follows on the next line.' },
    { k: 'signoff', label: 'Sign-off', text: '— {product}, for {company}', vars: ['product', 'company'] },
  ]),
  ...section('Email: billing greeting and sign-off', 'copy.email.billing', 'First and last lines of the billing emails (new invoice, payment failed, plan changed), sent to the billing contact, else the workspace owner.', [
    { k: 'greeting', label: 'Greeting', text: 'Hello,' },
    { k: 'signoff', label: 'Sign-off', text: '— The {product} team', vars: ['product'] },
  ]),
  ...section('Email: new invoice', 'copy.email.invoice_issued', 'Sent when a payment is received and its tax invoice raised.', [
    { k: 'subject', label: 'Subject', text: 'Invoice {number} from {product}', vars: ['number', 'product'] },
    {
      k: 'body',
      label: 'Body',
      text: 'Thank you for your payment. Invoice {number} for {company} has been issued.\n\nAmount (incl. GST): {amount}\nPeriod: {period}',
      vars: ['number', 'company', 'amount', 'period'],
      note: 'The greeting is added above it.',
    },
    { k: 'action', label: 'Link line', text: 'View and download the invoice:', note: 'The link to the invoice follows on the next line.' },
  ]),
  ...section('Email: payment failed', 'copy.email.payment_failed', 'Sent once per failed payment: an AutoPay renewal the bank refused, or a checkout payment that did not go through.', [
    { k: 'subject', label: 'Subject', text: 'Payment failed for {company} on {product}', vars: ['company', 'product'] },
    {
      k: 'body',
      label: 'Body',
      text: 'A payment of {amount} for {what} did not go through.\n\nReason: {reason}',
      vars: ['amount', 'what', 'reason'],
      note: 'The greeting is added above it.',
    },
    {
      k: 'retry',
      label: 'What happens next: renewal, will retry',
      text: 'We will try again automatically every day until {retry_until}. Please make sure your payment method can be charged, or pay now from the subscription page:',
      vars: ['retry_until'],
      note: 'The link to the subscription page follows on the next line.',
    },
    {
      k: 'final',
      label: 'What happens next: renewal, no more retries',
      text: 'No further automatic attempts will be made. Please pay from the subscription page to keep your workspace running:',
      note: 'The link to the subscription page follows on the next line.',
    },
    {
      k: 'checkout',
      label: 'What happens next: checkout',
      text: 'Nothing was charged and nothing has changed in your workspace. You can try again from the subscription page:',
      note: 'The link to the subscription page follows on the next line.',
    },
  ]),
  ...section('Email: plan changed', 'copy.email.plan_changed', 'Sent when the subscription plan changes, from the Subscription page or by the Pratibha team.', [
    { k: 'subject', label: 'Subject', text: 'Your {product} plan is now {new_plan}', vars: ['product', 'new_plan'] },
    {
      k: 'body',
      label: 'Body',
      text: '{company} has moved from {old_plan} to {new_plan}, effective {effective_date}.',
      vars: ['company', 'old_plan', 'new_plan', 'effective_date'],
      note: 'The greeting is added above it.',
    },
    { k: 'action', label: 'Link line', text: 'See your plan and usage:', note: 'The link to the subscription page follows on the next line.' },
  ]),
];

// ------------------------------------------------------------ public pages
const PUBLIC: SettingDef[] = [
  ...section('Public job page', 'copy.public.job', 'The public page for one role (/j/…), which candidates open from a post or the careers page.', [
    { k: 'interview_line', label: 'How the interview works', text: 'Interested? Shortlisted candidates will be invited to a short telephonic interview with Pratibha, our AI recruiter.', vars: ['company', 'job'], note: 'Shown above the interview phone number.' },
    { k: 'no_description', label: 'No description yet', text: 'No job description available.' },
    { k: 'not_found', label: 'Role not found', text: 'Job not found.' },
  ]),
  ...section('Careers page', 'copy.public.careers', "A workspace's public careers page (/careers/…).", [
    { k: 'subtitle', label: 'Line under the company name', text: 'Careers' },
    { k: 'open_roles', label: 'Roles heading', text: 'Open roles' },
    { k: 'no_roles', label: 'No open roles', text: 'No open roles right now. Check back soon.', vars: ['company'] },
    { k: 'paused', label: 'Workspace paused', text: 'Applications are paused at the moment.' },
    { k: 'not_found', label: 'Page not found', text: 'Careers page not found.' },
  ]),
];

// -------------------------------------------------------------- auth pages
const AUTH: SettingDef[] = [
  ...section('Log in', 'copy.auth.login', 'The log-in screen.', [
    { k: 'title', label: 'Heading', text: 'Welcome back' },
    { k: 'subtitle', label: 'Sub-heading', text: 'Log in to your hiring workspace.' },
    { k: 'email_label', label: 'Email field', text: 'Work email' },
    { k: 'password_label', label: 'Password field', text: 'Password' },
    { k: 'submit', label: 'Button', text: 'Log in' },
    { k: 'submitting', label: 'Button while working', text: 'Logging in…' },
    { k: 'no_account', label: 'Sign-up prompt', text: "Don't have an account?", note: 'Followed by the sign-up link.' },
    { k: 'signup_link', label: 'Sign-up link', text: 'Create a workspace' },
    { k: 'forgot_link', label: 'Forgot-password link', text: 'Forgot password?' },
    { k: 'error_link', label: 'Error: emailed link did not work', text: 'That link has expired or was already used. Log in, or use Forgot password? to get a new one.', note: 'Shown when a confirmation or reset link could not be used.' },
    { k: 'error_no_workspace', label: 'Error: login has no workspace', text: 'This login is not linked to a workspace. Sign up to create one, or ask your admin for an invite.' },
    { k: 'error_workspace_lookup', label: 'Error: workspace lookup failed', text: 'Could not determine your workspace. Please try again.' },
  ]),
  ...section('Sign up', 'copy.auth.signup', 'The create-a-workspace screen.', [
    { k: 'title', label: 'Heading', text: 'Create your workspace' },
    { k: 'subtitle', label: 'Sub-heading', text: 'Start screening candidates automatically.' },
    { k: 'company_label', label: 'Company field', text: 'Company name' },
    { k: 'slug_label', label: 'Workspace URL field', text: 'Workspace URL' },
    { k: 'slug_help', label: 'Workspace URL help', text: 'Lowercase letters, numbers and hyphens.' },
    { k: 'email_label', label: 'Email field', text: 'Your work email' },
    { k: 'password_label', label: 'Password field', text: 'Password' },
    { k: 'password_help', label: 'Password help', text: 'At least {min} characters.', vars: ['min'] },
    { k: 'submit', label: 'Button', text: 'Create workspace' },
    { k: 'submitting', label: 'Button while working', text: 'Creating workspace…' },
    { k: 'have_account', label: 'Log-in prompt', text: 'Already have an account?', note: 'Followed by the log-in link.' },
    { k: 'login_link', label: 'Log-in link', text: 'Log in' },
    { k: 'error_password_short', label: 'Error: password too short', text: 'Use a password of at least {min} characters.', vars: ['min'] },
    { k: 'error_workspace_name', label: 'Error: no workspace name', text: 'Enter a workspace name.' },
    { k: 'error_failed', label: 'Error: sign-up failed', text: 'Signup failed', note: 'Only when the server gives no reason of its own.' },
    { k: 'check_title', label: 'After sign-up: heading', text: 'Check your inbox' },
    { k: 'check_body', label: 'After sign-up: confirmation sent', text: 'We sent a link to {email}. Open it to confirm your address and go to your workspace.', vars: ['email'] },
    { k: 'check_failed', label: 'After sign-up: confirmation not sent', text: 'Your workspace is ready, but the confirmation email to {email} could not be sent. Try sending it again in a minute.', vars: ['email'] },
    { k: 'resend', label: 'After sign-up: resend button', text: 'Send the link again' },
    { k: 'resending', label: 'After sign-up: resend button while working', text: 'Sending…' },
    { k: 'resent', label: 'After sign-up: resent', text: 'Sent again. It can take a minute or two; check your spam folder too.' },
  ]),
  ...section('Verify email', 'copy.auth.verify', 'The enter-your-code screen.', [
    { k: 'title', label: 'Heading', text: 'Verify your email' },
    { k: 'code_label', label: 'Code field', text: 'Verification code' },
    { k: 'submit', label: 'Button', text: 'Verify' },
    { k: 'submitting', label: 'Button while working', text: 'Verifying...' },
    { k: 'error_failed', label: 'Error: verification failed', text: 'Verification failed', note: 'Only when the server gives no reason of its own.' },
    { k: 'resend_heading', label: 'Resend: heading', text: 'Need a new confirmation link?' },
    { k: 'resend_email_label', label: 'Resend: email field', text: 'Email you signed up with' },
    { k: 'resend_submit', label: 'Resend: button', text: 'Send a new link' },
    { k: 'resend_submitting', label: 'Resend: button while working', text: 'Sending…' },
    { k: 'resend_sent', label: 'Resend: sent', text: 'If that address is waiting to be confirmed, a new link is on its way.' },
  ]),
  ...section('Forgot password', 'copy.auth.forgot', 'The ask-for-a-reset-link screen, opened from "Forgot password?" on the log-in screen.', [
    { k: 'title', label: 'Heading', text: 'Reset your password' },
    { k: 'subtitle', label: 'Sub-heading', text: 'Enter the email you sign in with and we will send you a link to choose a new password.' },
    { k: 'email_label', label: 'Email field', text: 'Work email' },
    { k: 'submit', label: 'Button', text: 'Send reset link' },
    { k: 'submitting', label: 'Button while working', text: 'Sending…' },
    {
      k: 'sent',
      label: 'After sending',
      text: 'If an account uses {email}, a link to reset its password is on its way. It can take a minute or two; check your spam folder too.',
      vars: ['email'],
      note: 'Shown whether or not the address has an account, so the screen cannot be used to find out who does.',
    },
    { k: 'error_failed', label: 'Error: request failed', text: 'That did not work. Try again in a minute.' },
    { k: 'back_link', label: 'Back link', text: 'Back to log in' },
  ]),
  ...section('Reset password', 'copy.auth.reset', 'The choose-a-new-password screen a reset link opens.', [
    { k: 'title', label: 'Heading', text: 'Choose a new password' },
    { k: 'password_label', label: 'Password field', text: 'New password' },
    { k: 'confirm_label', label: 'Repeat field', text: 'New password again' },
    { k: 'submit', label: 'Button', text: 'Save password' },
    { k: 'submitting', label: 'Button while working', text: 'Saving...' },
    { k: 'error_short', label: 'Error: too short', text: 'Use at least eight characters.' },
    { k: 'error_mismatch', label: 'Error: passwords differ', text: 'The two passwords do not match.' },
    { k: 'error_expired', label: 'Error: link expired', text: 'This link has expired. Ask for a new one.' },
  ]),
];

// ------------------------------------------------------- candidate statuses
const STATUSES: SettingDef[] = section(
  'Candidate statuses',
  'copy.status',
  'The name of a pipeline status on badges, pickers and reports. Only the name changes; the order and meaning do not.',
  CANDIDATE_STATUSES.map((s) => ({ k: s, label: CANDIDATE_STATUS_LABELS[s], text: CANDIDATE_STATUS_LABELS[s] }))
);

// ----------------------------------------------------------------- portal
const PORTAL: SettingDef[] = [
  ...section('Portal: navigation', 'copy.portal.nav', 'The sidebar in the portal.', [
    { k: 'group_hiring', label: 'Hiring group', text: 'Hiring' },
    { k: 'overview', label: 'Overview link', text: 'Overview' },
    { k: 'jobs', label: 'Jobs link', text: 'Jobs' },
    { k: 'pipeline', label: 'Pipeline link', text: 'Pipeline' },
    { k: 'calls', label: 'Calls link', text: 'Calls' },
    { k: 'group_settings', label: 'Settings group', text: 'Settings' },
    { k: 'company', label: 'Company profile link', text: 'Company profile' },
    { k: 'subscription', label: 'Subscription link', text: 'Subscription' },
    { k: 'profile', label: 'My profile link', text: 'My profile' },
    { k: 'email', label: 'Email link', text: 'Email' },
    { k: 'team', label: 'Team link', text: 'Team' },
    { k: 'templates', label: 'Templates link', text: 'Templates' },
    { k: 'call_windows', label: 'Call windows link', text: 'Call windows' },
    { k: 'interview', label: 'Interview settings link', text: 'Interview' },
    { k: 'help_title', label: 'Help button', text: 'Ask Saarthi' },
    { k: 'help_sub', label: 'Help button sub-line', text: 'Product help, any time' },
  ]),
  ...section('Portal: activation (unpaid workspace)', 'copy.portal.activate', 'The only screen a workspace sees after sign-up until its first month is paid.', [
    { k: 'title', label: 'Heading', text: 'Activate {company}', vars: ['company'] },
    { k: 'intro', label: 'Explanation (owner)', text: "Choose a plan and pay for the first month. The same step sets up AutoPay, so each month renews on its own after your bank's pre-debit notice. You can change plan or turn AutoPay off any time." },
    { k: 'not_owner', label: 'Explanation (not the owner)', text: 'This workspace opens once its owner pays for the first month. Ask them to sign in and finish activation.' },
    { k: 'checking', label: 'Confirming payment', text: 'Confirming your payment with the bank…' },
    { k: 'phone_label', label: 'Phone field', text: 'Mobile number' },
    { k: 'phone_help', label: 'Phone help', text: 'Your bank sends AutoPay approvals and pre-debit notices here.' },
    { k: 'submit_amount', label: 'Pay button (plan chosen)', text: 'Pay {amount} and activate', vars: ['amount'] },
    { k: 'submit', label: 'Pay button (no plan yet)', text: 'Pay and activate' },
    { k: 'submitting', label: 'Pay button while working', text: 'Opening Cashfree…' },
    { k: 'footer', label: 'Small print', text: 'Includes {gst}% GST. Secure payment by Cashfree with UPI AutoPay or card.', vars: ['gst'] },
    { k: 'error_plans', label: 'Error: plans did not load', text: 'Could not load plans. Refresh to try again.' },
    { k: 'error_payment_failed', label: 'Error: payment failed', text: 'The payment did not go through. Try again, or use another UPI app or card.' },
    { k: 'error_bank_pending', label: 'Notice: bank has not confirmed', text: 'We have not heard back from your bank yet. This page will open your workspace once it confirms; refresh in a minute.' },
    { k: 'error_start', label: 'Error: payment did not start', text: 'Could not start the payment', note: 'Only when the server gives no reason of its own.' },
  ]),
  ...section('Portal: overview', 'copy.portal.overview', 'The overview (home) screen of the portal.', [
    { k: 'greeting_morning', label: 'Greeting before noon', text: 'Good morning' },
    { k: 'greeting_afternoon', label: 'Greeting noon to 5 pm', text: 'Good afternoon' },
    { k: 'greeting_evening', label: 'Greeting after 5 pm', text: 'Good evening' },
    { k: 'summary', label: 'Line under the greeting', text: 'Pratibha has read {applications} and completed {interviews}.', vars: ['applications', 'interviews'], note: 'Each placeholder is a count with its noun, e.g. "12 applications".' },
    { k: 'new_role', label: 'New role button', text: '+ New role' },
    { k: 'live_call', label: 'Live call banner', text: 'On a call with {name}', vars: ['name'] },
    { k: 'needs_heading', label: '"Needs you" heading', text: 'Needs you' },
    { k: 'needs_sub', label: '"Needs you" sub-line', text: 'Pratibha does the work — these are your decisions' },
    { k: 'approvals_title', label: 'Approvals card title', text: 'Shortlists awaiting approval' },
    { k: 'approvals_pending', label: 'Approvals card, some waiting', text: 'Nobody is contacted until you say so.' },
    { k: 'approvals_none', label: 'Approvals card, none waiting', text: 'Nothing waiting on you here.' },
    { k: 'approvals_button', label: 'Approvals card button', text: 'Review shortlists' },
    { k: 'reports_title', label: 'Reports card title', text: 'Recent interview reports' },
    { k: 'reports_none', label: 'Reports card, none', text: 'No interview reports yet.' },
    { k: 'reports_button', label: 'Reports card button', text: 'Read reports' },
    { k: 'no_phone_title_one', label: 'No-phone card title (one)', text: 'Candidate without a phone number' },
    { k: 'no_phone_title_many', label: 'No-phone card title (several)', text: 'Candidates without a phone number' },
    { k: 'no_phone_detail', label: 'No-phone card detail', text: "{name} applied for {job} — Pratibha can't invite them to call.", vars: ['name', 'job'] },
    { k: 'no_phone_none', label: 'No-phone card, none', text: 'Everyone we have can be reached.' },
    { k: 'no_phone_button', label: 'No-phone card button', text: 'Add number' },
    { k: 'mailbox_title', label: 'Mailbox card title', text: 'Mailbox & postings' },
    { k: 'mailbox_all_clear', label: 'Mailbox card, healthy', text: 'All clear' },
    { k: 'mailbox_none', label: 'Mailbox card, none connected', text: 'No mailbox connected — applications can only be added by hand.' },
    { k: 'mailbox_button', label: 'Mailbox card button', text: 'Open mailbox settings' },
    { k: 'funnel_heading', label: 'Funnel heading', text: 'This month’s pipeline' },
    { k: 'stage_applications', label: 'Funnel: applications', text: 'Applications' },
    { k: 'stage_screened', label: 'Funnel: screened', text: 'Screened' },
    { k: 'stage_shortlisted', label: 'Funnel: shortlisted', text: 'Shortlisted' },
    { k: 'stage_approved', label: 'Funnel: approved', text: 'Approved by you' },
    { k: 'stage_interviewed', label: 'Funnel: interviewed', text: 'Interviewed' },
    { k: 'stage_recommended', label: 'Funnel: recommended', text: 'Recommended' },
    { k: 'open_roles_heading', label: 'Open roles heading', text: 'Open roles' },
    { k: 'open_roles_empty', label: 'Open roles, none', text: 'No roles yet.', note: 'Followed by the create link.' },
    { k: 'open_roles_create', label: 'Open roles, create link', text: 'Create one' },
    { k: 'activity_heading', label: 'Activity heading', text: 'What Pratibha did today' },
    { k: 'activity_empty', label: 'Activity, none', text: 'Nothing yet today.' },
    { k: 'latest_heading', label: 'Latest applications heading', text: 'Latest applications' },
    { k: 'latest_empty', label: 'Latest applications, none', text: 'No applications yet.' },
    { k: 'loading', label: 'Loading', text: 'Loading your overview…' },
    { k: 'load_error', label: 'Error: did not load', text: 'Could not load your overview', note: 'Only when the server gives no reason of its own.' },
  ]),
  ...section('Portal: jobs', 'copy.portal.jobs', 'The Jobs list, and the create and edit role screens.', [
    { k: 'title', label: 'Heading', text: 'Jobs' },
    { k: 'intro', label: 'Sub-heading', text: 'Roles you are hiring for. Applications are filed against these.' },
    { k: 'new_job', label: 'New job button', text: 'New job' },
    { k: 'empty_title', label: 'No jobs: heading', text: 'No jobs yet' },
    { k: 'empty_body', label: 'No jobs: explanation', text: 'Create a job first. Applications need a role to be filed against before a mailbox can import them.' },
    { k: 'empty_button', label: 'No jobs: button', text: 'Create your first job' },
    { k: 'no_match', label: 'Search finds no open role', text: 'No roles match “{query}”.', vars: ['query'] },
    { k: 'no_match_archived', label: 'Search finds no archived role', text: 'No archived roles match “{query}”.', vars: ['query'] },
    { k: 'none_open', label: 'No open roles', text: 'No open roles. Archived ones are under the Archived tab.' },
    { k: 'none_archived', label: 'No archived roles', text: 'No archived roles.' },
    { k: 'create_title', label: 'Create job: heading', text: 'Create job' },
    { k: 'create_intro', label: 'Create job: sub-heading', text: 'Applications are filed against a job, so this comes first.' },
    { k: 'edit_title', label: 'Edit role: heading', text: 'Edit role' },
    { k: 'edit_intro', label: 'Edit role: sub-heading', text: 'Saving keeps the previous version. Nothing is overwritten.' },
    { k: 'edit_published', label: 'Edit role: published notice', text: '**This role is published.** It is live on {channels}. Editing here does not update the live posting — you will need to publish again for applicants to see these changes.', vars: ['channels'], note: BOLD },
    { k: 'edit_jd_changed', label: 'Edit role: description changed', text: '**The job description has changed**, so the published advert still shows the old text.', note: `Added to the published notice. ${BOLD}` },
  ]),
  ...section('Portal: job tabs', 'copy.portal.job', "The tabs and tab headings inside one job.", [
    { k: 'tab_studio', label: 'JD Studio tab', text: 'JD Studio' },
    { k: 'tab_candidates', label: 'Candidates tab', text: 'Candidates' },
    { k: 'tab_shortlist', label: 'Shortlist tab', text: 'Shortlist' },
    { k: 'tab_publish', label: 'Publish tab', text: 'Publish' },
    { k: 'tab_interviews', label: 'Interviews tab', text: 'Interviews' },
    { k: 'studio.intro', label: 'JD Studio sub-heading', text: 'Write or generate the description, save it as a version, then approve it. Only an approved version can be published.' },
    { k: 'candidates.intro', label: 'Candidates sub-heading', text: "Screening scores each CV against the job's must haves. Anyone it suggests moves to the Shortlist tab for your approval." },
    { k: 'publish.intro', label: 'Publish sub-heading', text: 'Make this role public so candidates can find and apply to it.' },
    { k: 'interviews.intro_none', label: 'Interviews sub-heading, none yet', text: 'No interviews completed yet. Reports are ready within minutes of each call.' },
    { k: 'interviews.intro', label: 'Interviews sub-heading', text: '{count} completed. Reports are ready within minutes of each call. Pratibha recommends, you decide.', vars: ['count'] },
  ]),
  ...section('Portal: shortlist', 'copy.portal.job.shortlist', 'The Shortlist tab of a job, where a person approves who may be interviewed.', [
    { k: 'intro', label: 'Sub-heading', text: 'Approving the shortlist is what lets these candidates be interviewed. Until then, Pratibha refuses their call.' },
    { k: 'pending_heading', label: 'Waiting heading', text: 'Waiting for your approval · {count}', vars: ['count'], note: '{count} is a number with its noun, e.g. "3 candidates".' },
    { k: 'not_approved_chip', label: 'Not approved chip', text: 'Not approved yet' },
    { k: 'no_email_warning', label: 'Warning: no email', text: 'No email address, so no invitation can be sent to them.' },
    { k: 'no_phone_warning', label: 'Warning: no phone', text: 'No phone number, so Pratibha cannot recognise their call yet.' },
    { k: 'approve_button', label: 'Approve button', text: 'Approve shortlist · {count}', vars: ['count'], note: '{count} is a number with its noun.' },
    { k: 'approving', label: 'Approve button while working', text: 'Approving…' },
    { k: 'approve_not_allowed', label: 'Approve not allowed (tooltip)', text: 'Only reviewers, admins and owners can approve' },
    { k: 'add_more', label: 'Add more link', text: 'Add more from Candidates' },
    { k: 'none_waiting', label: 'Nobody waiting', text: 'Nobody is waiting for approval. Screening adds the candidates it suggests here.', note: 'Followed by the Candidates link.' },
    { k: 'go_to_candidates', label: 'Candidates link', text: 'Go to Candidates' },
    { k: 'approved_heading', label: 'Approved heading', text: 'Previously approved' },
    { k: 'removed_heading', label: 'Removed heading', text: 'Removed from this shortlist' },
    { k: 'empty_none_title', label: 'Empty, no candidates: heading', text: 'No candidates yet' },
    { k: 'empty_none_body', label: 'Empty, no candidates: explanation', text: 'Add CVs to this job, then screen them to build a shortlist.' },
    { k: 'empty_none_button', label: 'Empty, no candidates: button', text: 'Add candidates' },
    { k: 'empty_unscreened_title', label: 'Empty, none screened: heading', text: 'Nothing screened yet' },
    { k: 'empty_unscreened_body', label: 'Empty, none screened: explanation', text: '{waiting} waiting. Screening is what scores them and puts anyone above the threshold on this shortlist.', vars: ['waiting'], note: '{waiting} reads like "3 candidates are".' },
    { k: 'empty_unscreened_button', label: 'Empty, none screened: button', text: 'Screen candidates' },
    { k: 'empty_below_title', label: 'Empty, all below threshold: heading', text: 'Everyone scored below the threshold' },
    { k: 'empty_below_body', label: 'Empty, all below threshold: explanation', text: "{who} not suggested. The best score was {best}, and the threshold is {threshold}, so nobody reached the shortlist. Lower the job's threshold, or relax its must haves, and screen again.", vars: ['who', 'best', 'threshold'], note: '{who} reads like "All 4 screened candidates were".' },
    { k: 'empty_below_edit', label: 'Empty, all below threshold: edit button', text: 'Edit the job' },
    { k: 'empty_below_review', label: 'Empty, all below threshold: review button', text: 'Review candidates' },
  ]),
  ...section('Portal: pipeline', 'copy.portal.pipeline', 'The Pipeline screen (every application).', [
    { k: 'title', label: 'Heading', text: 'Pipeline' },
    { k: 'intro', label: 'Sub-heading', text: 'Every application that arrived, newest first, and the ones that need a hand from you.' },
    { k: 'mode_line', label: 'Screening mode explanation', text: 'Auto screens matched applications as they arrive. Manual queues them for you. {used} of {allowance} screenings used this month.', vars: ['used', 'allowance'] },
    { k: 'empty', label: 'Nothing in this view', text: 'Nothing here.' },
    { k: 'no_match', label: 'Search finds nothing', text: 'Nothing matches this search.' },
  ]),
  ...section('Portal: candidate', 'copy.portal.candidate', "One candidate's page.", [
    { k: 'screening_heading', label: 'Screening heading', text: 'Screening' },
    { k: 'not_screened', label: 'Not screened', text: 'Not screened yet.' },
    { k: 'calls_heading', label: 'Call history heading', text: 'Call history' },
    { k: 'no_calls', label: 'No calls', text: 'This candidate has not called yet.' },
    { k: 'report_heading', label: 'Interview report heading', text: 'Interview report' },
    { k: 'notes_heading', label: 'Notes heading', text: 'Notes' },
    { k: 'no_notes', label: 'No notes', text: 'No notes yet.' },
    { k: 'timeline_heading', label: 'Timeline heading', text: 'Timeline' },
  ]),
  ...section('Portal: calls', 'copy.portal.calls', 'The Calls screen.', [
    { k: 'title', label: 'Heading', text: 'Calls' },
    { k: 'intro', label: 'Sub-heading', text: 'Every call Pratibha has taken — including the ones that did not work.' },
    { k: 'unmatched_notice', label: 'Unrecognised callers notice', text: 'Callers we could not recognise are not listed here. Pratibha answers on one number shared by every workspace, so an unmatched call cannot be attributed to a tenant — those are recorded on the platform log instead.' },
    { k: 'empty', label: 'No calls', text: 'No calls in this period.' },
    { k: 'truncated', label: 'Too many calls', text: 'Showing the most recent 500 calls. Narrow the date range to see earlier ones.' },
  ]),
  ...section('Portal: settings pages', 'copy.portal.settings', 'Headings and opening lines of the settings screens.', [
    { k: 'company.title', label: 'Company profile: heading', text: 'Company profile' },
    { k: 'company.intro', label: 'Company profile: sub-heading', text: 'Your company as it appears to candidates and on invoices.' },
    { k: 'profile.title', label: 'My profile: heading', text: 'My profile' },
    { k: 'profile.intro', label: 'My profile: sub-heading', text: 'Your own account. Company details are in', note: 'Followed by the Company profile link and a full stop.' },
    { k: 'profile.company_link', label: 'My profile: company link', text: 'Company profile' },
    { k: 'email.title', label: 'Email: heading', text: 'Email settings' },
    { k: 'email.intro', label: 'Email: sub-heading', text: 'Connect the mailboxes that receive applications — Gmail, Outlook, your company webmail, or forward mail to a private Pratibha address. Pratibha reads new mail, extracts the CV, and creates a candidate automatically.' },
    { k: 'team.title', label: 'Team: heading', text: 'Team' },
    { k: 'team.intro', label: 'Team: sub-heading', text: 'Invite teammates and control what they can see and change.' },
    { k: 'templates.title', label: 'Templates: heading', text: 'Outreach templates' },
    { k: 'templates.intro', label: 'Templates: sub-heading', text: 'The emails Pratibha sends candidates at each stage. Edit and save each one independently.' },
    { k: 'call_windows.title', label: 'Call windows: heading', text: 'Call windows' },
    { k: 'call_windows.intro', label: 'Call windows: sub-heading', text: 'When the agent will answer screening calls for each job. Outside these hours a caller is told to try again later.' },
    { k: 'interview.title', label: 'Interview: heading', text: 'Interview settings' },
    { k: 'interview.intro', label: 'Interview: sub-heading', text: 'Decide what Pratibha covers on every call. Each choice costs interview time, and the plan on the right keeps the total honest.' },
  ]),
  ...section('Portal: subscription', 'copy.portal.subscription', 'The Subscription screen (plan, payments, invoices, cancelling).', [
    { k: 'title', label: 'Heading', text: 'Subscription' },
    { k: 'no_limit', label: 'Plan without a minute limit', text: 'This plan has no minute limit.' },
    { k: 'overage', label: 'Over the plan', text: '{minutes} minutes used beyond your plan this period.', vars: ['minutes'] },
    { k: 'usage_warning', label: 'Running low', text: 'You have used {percent}% of your minutes.', vars: ['percent'] },
    { k: 'cancel_scheduled', label: 'Cancellation scheduled notice', text: '**Scheduled to end** on {date}. Your data becomes read-only then and is deleted {days} days later.', vars: ['date', 'days'], note: BOLD },
    { k: 'keep_button', label: 'Undo cancellation button', text: 'Keep my subscription' },
    { k: 'phone_label', label: 'Payments phone field', text: 'Mobile number for payments' },
    { k: 'phone_help', label: 'Payments phone help', text: 'Used by Cashfree for payment confirmations. Enter it once before buying a plan or minutes.' },
    { k: 'plan_heading', label: 'Plan heading', text: 'Plan' },
    { k: 'current_plan', label: 'Current plan badge', text: 'Current plan' },
    { k: 'owner_only', label: 'Only the owner (tooltip)', text: 'Only the workspace owner can change the plan' },
    { k: 'payment_heading', label: 'Payment method heading', text: 'Payment method' },
    { k: 'no_gateway', label: 'No payment gateway', text: 'No payment gateway is connected yet. Plan changes are recorded here and actioned by the Pratibha team.' },
    { k: 'no_method', label: 'No payment method', text: 'No payment method saved.' },
    { k: 'autopay_button', label: 'Set up AutoPay button', text: 'Set up AutoPay' },
    { k: 'autopay_help', label: 'AutoPay explanation', text: 'Authorise once with UPI AutoPay, eNACH or a card. Each renewal is charged a few days before the period ends, after your bank sends a pre-debit notice.' },
    { k: 'billing_heading', label: 'Billing details heading', text: 'Billing details' },
    { k: 'billing_help_before', label: 'Billing details: before link', text: 'Taken from' },
    { k: 'billing_help_link', label: 'Billing details: link', text: 'Company profile' },
    { k: 'billing_help_after', label: 'Billing details: after link', text: ', so there is one source of truth. These appear on every invoice.' },
    { k: 'contact_heading', label: 'Billing contact heading', text: 'Billing contact' },
    { k: 'contact_help', label: 'Billing contact explanation', text: 'Invoices go here as well as to the owner. This is an email address, not a login — they will not be able to see candidates or hiring data.' },
    { k: 'topup_heading', label: 'Top-up heading', text: 'Buy more minutes' },
    { k: 'coupon_heading', label: 'Coupon heading', text: 'Have a coupon?' },
    { k: 'invoices_heading', label: 'Invoices heading', text: 'Invoices' },
    { k: 'invoices_empty', label: 'No invoices', text: 'No invoices yet.' },
    { k: 'cancel_heading', label: 'Cancel heading', text: 'Cancel subscription' },
    { k: 'cancel_button', label: 'Cancel button', text: 'Cancel subscription' },
    { k: 'cancel_warning', label: 'What cancelling does', text: '**What happens:** you keep full access until {date}. After that your workspace becomes **read-only** — you can still read candidates, transcripts and reports, but not run new interviews. **{days} days later the data is deleted** and cannot be recovered.', vars: ['date', 'days'], note: BOLD },
    { k: 'cancel_reason_label', label: 'Reason field', text: 'Why are you leaving?' },
    { k: 'cancel_reason.too_expensive', label: 'Reason: too expensive', text: 'Too expensive' },
    { k: 'cancel_reason.not_enough_hiring', label: 'Reason: not hiring enough', text: 'Not hiring enough to justify it' },
    { k: 'cancel_reason.missing_features', label: 'Reason: missing features', text: 'Missing features we need' },
    { k: 'cancel_reason.quality', label: 'Reason: quality', text: 'Interview quality did not meet our bar' },
    { k: 'cancel_reason.switched', label: 'Reason: switched', text: 'Moved to another product' },
    { k: 'cancel_reason.other', label: 'Reason: other', text: 'Something else' },
    { k: 'cancel_comment_label', label: 'Comment field', text: 'Anything else? (optional)' },
    { k: 'cancel_keep', label: 'Back out button', text: 'Keep it' },
    { k: 'cancel_confirm', label: 'Confirm button', text: 'Confirm cancellation' },
    { k: 'cancel_done', label: 'After cancelling', text: 'Your subscription will end at the close of this period.' },
  ]),
];

export const COPY_SETTINGS: SettingDef[] = [...EMAILS, ...PUBLIC, ...AUTH, ...STATUSES, ...PORTAL];
