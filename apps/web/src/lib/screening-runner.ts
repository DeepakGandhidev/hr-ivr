import { adminPrisma, withTenant } from "@pratibha/prisma";
import { writeAuditLog } from "@pratibha/shared";
import type { PrismaClient } from "@pratibha/prisma";
import { currentTrial } from "@/lib/pricing";
import { platformSettings } from "@/lib/platform-settings";
import { screenCandidate } from "@/lib/screen-candidate";

/**
 * Works off the screening queue: Auto mode arrivals, Screen now, and moves in
 * Auto mode all set `screening_queued_at`; this screens them, oldest first,
 * through the same screenCandidate the button uses.
 *
 * Runs in the portal process every minute (instrumentation.ts) and is kicked
 * straight after a Screen now. One run at a time per process.
 */
const PAUSED = ["suspended", "deleted_pending", "deleted"];
let running = false;

export async function runScreeningQueue(): Promise<number> {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    const batch = Math.max(1, (await platformSettings()).autoScreenBatch || 10);

    const queued = await adminPrisma.candidate.findMany({
      where: { screeningQueuedAt: { not: null }, archivedAt: null, notApplicationAt: null },
      orderBy: { screeningQueuedAt: "asc" },
      take: batch,
      select: { id: true, tenantId: true },
    });

    for (const item of queued) {
      const tenant = await adminPrisma.tenant.findUnique({ where: { id: item.tenantId }, include: { plan: true } });
      if (!tenant || PAUSED.includes(tenant.status)) continue;
      const trial = tenant.status === "trial" ? await currentTrial() : null;
      try {
        await screenCandidate({
          tenant: { ...tenant, trial },
          candidateId: item.id,
          actorId: "ai",
          tx: (cb) => withTenant(tenant.id, cb),
        });
        done += 1;
      } catch (error) {
        // Out of screenings: leave it queued; it runs once the allowance moves.
        const code = (error as { code?: string }).code;
        if (code === "QUOTA_EXCEEDED") continue;
        // Anything else: take it off the queue so it cannot loop, and say why.
        await adminPrisma.candidate.update({ where: { id: item.id }, data: { screeningQueuedAt: null } });
        await writeAuditLog(adminPrisma as unknown as PrismaClient, {
          tenantId: tenant.id,
          actor: "system",
          action: "candidate.screening_failed",
          entity: "candidate",
          entityId: item.id,
          reason: (error as Error).message?.slice(0, 300) ?? "Screening failed",
        }).catch(() => {});
      }
    }
  } catch (error) {
    console.error("[screening queue] run failed", error);
  } finally {
    running = false;
  }
  return done;
}
