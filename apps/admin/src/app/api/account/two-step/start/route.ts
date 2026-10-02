import { type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handle, conflict } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { newTotpSecret, otpauthUri, groupedSecret } from "@/lib/auth/totp";
import { sealTotp } from "@/lib/auth/secrets";

export const runtime = "nodejs";

/**
 * Begin enrolment: a fresh secret is stored (sealed) but not yet in force.
 * It only counts once a code from it has been entered, so an abandoned
 * enrolment leaves two step verification exactly as it was: off.
 */
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("view");
    if (admin.totpEnabledAt) throw conflict("Two step verification is already on for your account.");

    const secret = newTotpSecret();
    await db.adminUser.update({ where: { id: admin.id }, data: { totpSecret: sealTotp(secret) } });
    return { secret: groupedSecret(secret), uri: otpauthUri(secret, admin.email) };
  });
}
