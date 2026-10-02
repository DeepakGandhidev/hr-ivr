import type { AdminSession, AdminUser } from "@pratibha/prisma";
import { can, PERMISSIONS, type Permission } from "@/lib/auth/roles";
import { codeIsRecent } from "@/lib/auth/session";
import { currentPlans, livePacks, packLabel } from "@/lib/pricing";
import { getSetting } from "@/lib/settings";

/**
 * What the client-side dialogs need to know about the signed-in admin and the
 * live catalogue: which actions to offer, which to explain away, and the
 * choices inside them. The server re-checks every one of these on submit.
 */
export interface PanelContext {
  role: AdminUser["role"];
  allowed: Record<Permission, boolean>;
  twoStepOn: boolean;
  codeRecent: boolean;
  goodwillCap: number;
  plans: { key: string; name: string; priceInr: number; minutes: number }[];
  packs: { id: string; label: string; kind: "minutes" | "screenings"; quantity: number; priceInr: number }[];
}

export async function panelContext(admin: AdminUser, session: AdminSession): Promise<PanelContext> {
  const [plans, packs, cap, recent] = await Promise.all([
    currentPlans(),
    livePacks(),
    getSetting("admin.goodwill_cap_minutes"),
    codeIsRecent(session),
  ]);
  const allowed = Object.fromEntries(PERMISSIONS.map((p) => [p, can(admin.role, p)])) as Record<Permission, boolean>;
  return {
    role: admin.role,
    allowed,
    twoStepOn: Boolean(admin.totpEnabledAt),
    codeRecent: recent,
    goodwillCap: Number(cap),
    plans: plans.map((p) => ({ key: p.key, name: p.name, priceInr: p.priceInr, minutes: p.minutes })),
    packs: packs.map((p) => ({ id: p.id, label: packLabel(p), kind: p.kind, quantity: p.quantity, priceInr: p.priceInr })),
  };
}
