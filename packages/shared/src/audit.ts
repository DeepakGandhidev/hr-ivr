import type { PrismaClient, Prisma } from '@pratibha/prisma';

/**
 * The slice of the client this module uses.
 *
 * Typed as the capability rather than the whole client so a transaction handle
 * is accepted: audit entries most want writing inside the transaction that made
 * the change, and demanding the full PrismaClient forced every such caller
 * through a double cast that quietly defeated the type entirely.
 */
type AuditDb = Pick<PrismaClient, 'auditLog'>;

export interface AuditEntry {
  tenantId: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
}

export async function writeAuditLog(
  prisma: AuditDb,
  entry: AuditEntry
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      tenantId: entry.tenantId,
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      before: entry.before ? (entry.before as Prisma.JsonObject) : undefined,
      after: entry.after ? (entry.after as Prisma.JsonObject) : undefined,
      reason: entry.reason,
    },
  });
}

export async function logAuthzDenial(
  prisma: AuditDb,
  tenantId: string,
  actor: string,
  action: string,
  entity: string,
  entityId: string,
  reason: string
): Promise<void> {
  await writeAuditLog(prisma, {
    tenantId,
    actor,
    action: `authz.denied.${action}`,
    entity,
    entityId,
    reason,
  });
}
