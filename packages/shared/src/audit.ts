import type { PrismaClient, Prisma } from '@pratibha/prisma';

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
  prisma: PrismaClient,
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
  prisma: PrismaClient,
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
