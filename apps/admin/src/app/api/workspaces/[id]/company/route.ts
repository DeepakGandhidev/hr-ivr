import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { updateCompany } from "@/lib/workspace-edit-actions";
import { EDIT_PERMISSION } from "@/lib/workspace-edit";

export const runtime = "nodejs";

// Outer bounds, as the portal's route has; the real limits are Platform
// settings, checked in checkCompanyProfile.
const field = (max: number) => z.string().max(max).nullable().optional();
const schema = z.object({
  legalName: field(1000),
  addressLine: field(2000),
  city: field(1000),
  pinCode: field(20),
  billingState: field(100),
  gstin: field(20),
  description: field(20000),
  reason: z.string().optional(),
});

/** The company profile: what goes on an invoice and the careers page. */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin(EDIT_PERMISSION);
    const { reason, ...input } = await parseBody(request, schema);
    return updateCompany(admin, params.id, input, requireReason(reason, "editing a company profile"));
  });
}
