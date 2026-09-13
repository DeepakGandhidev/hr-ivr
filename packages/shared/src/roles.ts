export enum UserRole {
  owner = 'owner',
  admin = 'admin',
  reviewer = 'reviewer',
  viewer = 'viewer',
}

export const ROLE_HIERARCHY: UserRole[] = [
  UserRole.viewer,
  UserRole.reviewer,
  UserRole.admin,
  UserRole.owner,
];

export function roleRank(role: UserRole): number {
  const idx = ROLE_HIERARCHY.indexOf(role);
  return idx === -1 ? -1 : idx;
}

export function hasRole(role: UserRole, required: UserRole): boolean {
  return roleRank(role) >= roleRank(required);
}

export enum Action {
  // Jobs
  jobCreate = 'job:create',
  jobRead = 'job:read',
  jobUpdate = 'job:update',
  jobDelete = 'job:delete',
  jobApproveJD = 'job:approve-jd',
  jobPublish = 'job:publish',

  // Candidates
  candidateRead = 'candidate:read',
  candidateCreate = 'candidate:create',
  candidateUpdate = 'candidate:update',
  candidateScreen = 'candidate:screen',
  candidateStatus = 'candidate:status',

  // Shortlists
  shortlistRead = 'shortlist:read',
  shortlistEdit = 'shortlist:edit',
  shortlistApprove = 'shortlist:approve',

  // Outreach
  outreachTemplateRead = 'outreach-template:read',
  outreachTemplateUpdate = 'outreach-template:update',
  outreachSend = 'outreach:send',

  // Protocols
  protocolRead = 'protocol:read',
  protocolUpdate = 'protocol:update',

  // Team / billing
  teamManage = 'team:manage',
  billingManage = 'billing:manage',
  settingsRead = 'settings:read',
  settingsUpdate = 'settings:update',
}

const PERMISSIONS: Record<Action, UserRole> = {
  [Action.jobCreate]: UserRole.admin,
  [Action.jobRead]: UserRole.viewer,
  [Action.jobUpdate]: UserRole.admin,
  // Archiving a role is at least as consequential as editing one - it hides a
  // job that candidates have already been screened against - so it sits at the
  // same level rather than below it.
  [Action.jobDelete]: UserRole.admin,
  [Action.jobApproveJD]: UserRole.reviewer,
  [Action.jobPublish]: UserRole.admin,

  [Action.candidateRead]: UserRole.viewer,
  // Adding a CV by hand writes into the same pipeline the mailbox feeds, so it
  // sits at the same level as screening rather than with the read actions.
  [Action.candidateCreate]: UserRole.admin,
  // Moving a candidate between jobs discards their screening and shortlist
  // placement for the old role, so it sits with the other candidate writes.
  [Action.candidateUpdate]: UserRole.admin,
  [Action.candidateScreen]: UserRole.admin,
  // Moving someone along the pipeline is the reviewer's daily work, and sits
  // with shortlisting rather than with the admin-only candidate writes: it
  // changes a label, not the candidate record or which job they belong to.
  [Action.candidateStatus]: UserRole.reviewer,

  [Action.shortlistRead]: UserRole.viewer,
  [Action.shortlistEdit]: UserRole.reviewer,
  [Action.shortlistApprove]: UserRole.reviewer,

  [Action.outreachTemplateRead]: UserRole.viewer,
  [Action.outreachTemplateUpdate]: UserRole.admin,
  [Action.outreachSend]: UserRole.admin,

  [Action.protocolRead]: UserRole.viewer,
  [Action.protocolUpdate]: UserRole.admin,

  [Action.teamManage]: UserRole.owner,
  [Action.billingManage]: UserRole.owner,
  [Action.settingsRead]: UserRole.viewer,
  [Action.settingsUpdate]: UserRole.admin,
};

export function can(role: UserRole, action: Action): boolean {
  const required = PERMISSIONS[action];
  if (!required) return false;
  return hasRole(role, required);
}
