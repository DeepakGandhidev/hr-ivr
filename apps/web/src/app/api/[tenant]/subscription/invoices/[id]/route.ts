import { NextRequest } from "next/server";
import { Action, NotFoundError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export const runtime = "nodejs";

/**
 * One invoice, in full.
 *
 * Readable by an admin rather than owner-only: an invoice is a record of what
 * happened, and the person who has to file it is not always the account holder.
 * Changing money is what stays owner-only.
 *
 * Row-level security scopes this to the caller's tenant, so an invoice id from
 * another workspace resolves to nothing — reported as a 404 rather than a null
 * the page would have to guess at.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.billingRead, async (_ctx, tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id } });
      if (!invoice) throw new NotFoundError("Invoice not found");

      return { invoice };
    })
  );
}
