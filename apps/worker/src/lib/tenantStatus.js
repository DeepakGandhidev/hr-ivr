/**
 * Workspaces nobody may use: suspended by an admin, or held for deletion.
 * Pure, so the call flow and the screening runner can share it without a
 * database import.
 */
const PAUSED_TENANT_STATUSES = new Set(['suspended', 'deleted_pending', 'deleted']);

export function isTenantPaused(tenant) {
  return Boolean(tenant && PAUSED_TENANT_STATUSES.has(tenant.status));
}
