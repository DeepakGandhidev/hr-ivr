import { createClient } from "@/lib/supabase/server";
import { adminPrisma, withTenant } from "@pratibha/prisma";
import { Action, can, ForbiddenError, logAuthzDenial, TenantMismatchError, UnauthorizedError, UserRole } from "@pratibha/shared";
import type { User, Tenant, PrismaClient } from "@pratibha/prisma";

export interface RequestContext {
  user: User;
  tenant: Tenant;
}

export async function getSessionUser() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function requireAuth(): Promise<{ authUserId: string; email: string }> {
  const authUser = await getSessionUser();
  if (!authUser) {
    throw new UnauthorizedError();
  }
  return { authUserId: authUser.id, email: authUser.email! };
}

export async function loadTenantContext(tenantSlug: string): Promise<RequestContext> {
  const { authUserId } = await requireAuth();

  // Session bootstrap: which tenant does this slug name, and does the signed-in
  // user belong to it? Neither question can be answered from inside a tenant
  // context, so these two reads deliberately use the unfiltered client. The
  // tenant match is enforced immediately below, and every subsequent query runs
  // through withTenant() under RLS.
  const tenant = await adminPrisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) {
    throw new ForbiddenError("Unknown tenant");
  }

  const user = await adminPrisma.user.findUnique({
    where: { authProviderId: authUserId },
  });

  if (!user || user.tenantId !== tenant.id) {
    throw new TenantMismatchError();
  }

  return { user, tenant };
}

export function requireAction(ctx: RequestContext, action: Action): RequestContext {
  const role = ctx.user.role as unknown as UserRole;
  if (!can(role, action)) {
    throw new ForbiddenError(`Action ${action} not permitted for role ${ctx.user.role}`);
  }
  return ctx;
}

export type TenantTransactionClient = Parameters<Parameters<typeof withTenant>[1]>[0];

export async function withTenantAuth<T>(
  tenantSlug: string,
  action: Action,
  cb: (ctx: RequestContext, tx: TenantTransactionClient) => Promise<T>
): Promise<T> {
  const ctx = await loadTenantContext(tenantSlug);
  const role = ctx.user.role as unknown as UserRole;

  // The role check happens BEFORE the work transaction opens. Logging a denial
  // inside that transaction and then throwing rolled the log entry back with
  // it, so §8's "violation log: every 403 from authz" recorded nothing for the
  // endpoints that use this wrapper.
  if (!can(role, action)) {
    await recordAuthzDenial(ctx, action);
    throw new ForbiddenError(`Action ${action} not permitted for role ${ctx.user.role}`);
  }

  return withTenant(ctx.tenant.id, (tx) => cb(ctx, tx));
}

/**
 * Writes the violation entry on its own connection so it survives the 403. It
 * must never mask the denial, so a logging failure is reported and swallowed.
 */
async function recordAuthzDenial(ctx: RequestContext, action: Action): Promise<void> {
  try {
    await logAuthzDenial(
      adminPrisma as unknown as PrismaClient,
      ctx.tenant.id,
      ctx.user.id,
      action,
      'tenant',
      ctx.tenant.id,
      `Action ${action} not permitted for role ${ctx.user.role}`
    );
  } catch (error) {
    console.error('Failed to write authz denial audit entry', error);
  }
}

/**
 * Authorize once, then run several short transactions against the same tenant.
 *
 * withTenant() opens a Prisma interactive transaction, which defaults to a
 * 5-second timeout. A model call routinely takes longer than that, so anything
 * that screens a CV or drafts a JD inside withTenantAuth() aborts with
 * "Transaction already closed" and the work is lost. The model call also has no
 * business holding a database connection open while it waits.
 *
 * This gives a route the same authz guarantees (session, tenant match, role,
 * denial logging) while letting it read inputs, leave the transaction to call
 * the model, and open a second short transaction for the writes.
 */
export async function authorizeTenant(
  tenantSlug: string,
  action: Action
): Promise<{ ctx: RequestContext; tx: <T>(cb: (tx: TenantTransactionClient) => Promise<T>) => Promise<T> }> {
  const ctx = await loadTenantContext(tenantSlug);
  const role = ctx.user.role as unknown as UserRole;

  if (!can(role, action)) {
    await recordAuthzDenial(ctx, action);
    throw new ForbiddenError(`Action ${action} not permitted for role ${ctx.user.role}`);
  }

  return {
    ctx,
    tx: <T,>(cb: (tx: TenantTransactionClient) => Promise<T>) => withTenant(ctx.tenant.id, cb),
  };
}
