import { PrismaClient as BasePrismaClient, Prisma } from './generated/client/index.js';

export * from './generated/client/index.js';

export declare const prisma: BasePrismaClient;

/**
 * Not filtered by row-level security. Only for resolving the session's user and
 * tenant before a tenant context exists.
 */
export declare const adminPrisma: BasePrismaClient;

export declare function withTenant<T>(
  tenantId: string,
  cb: (tx: Omit<BasePrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>) => Promise<T>
): Promise<T>;

export { BasePrismaClient as PrismaClient };
