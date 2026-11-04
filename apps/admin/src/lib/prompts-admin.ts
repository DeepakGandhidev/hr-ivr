import type { AdminUser, PromptTemplateKey } from "@pratibha/prisma";
import { parseBlockLibrary } from "@pratibha/shared";
import { db } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import { badRequest, notFound } from "@/lib/http";

/**
 * The AI prompts, versioned.
 *
 * A save never edits a version in place: it adds the next version number, so
 * every wording that has ever run on a call can be read back and restored.
 * Exactly one version per prompt is active. The portal reads the active one on
 * each request; the call line caches it for up to a minute.
 */

export const PROMPTS: { key: PromptTemplateKey; label: string; usedFor: string; app: string; json: boolean }[] = [
  { key: "interviewer_system", label: "Interviewer", usedFor: "How the agent runs every phone interview: its stages, tone and rules.", app: "Call line, within 1 minute", json: true },
  { key: "report_generation", label: "Interview report", usedFor: "How a finished call is scored and written up for the recruiter.", app: "Call line, next report", json: false },
  { key: "cv_screening", label: "CV screening", usedFor: "How a CV is scored against the job's must-haves.", app: "Portal, next screening", json: false },
  { key: "jd_generation", label: "Job description writer", usedFor: "How a job description is drafted from a title and notes.", app: "Portal, next draft", json: false },
];

export function promptMeta(key: string) {
  const meta = PROMPTS.find((p) => p.key === key);
  if (!meta) throw notFound("No such prompt.");
  return meta;
}

export async function promptVersions(key: PromptTemplateKey) {
  return db.promptTemplate.findMany({
    where: { key },
    orderBy: { version: "desc" },
    select: { id: true, version: true, active: true, createdAt: true, body: true },
  });
}

export async function promptOverview() {
  const rows = await db.promptTemplate.findMany({
    select: { key: true, version: true, active: true, createdAt: true },
    orderBy: { version: "desc" },
  });
  return PROMPTS.map((p) => {
    const mine = rows.filter((r) => r.key === p.key);
    return { ...p, versions: mine.length, active: mine.find((r) => r.active) ?? null, latest: mine[0] ?? null };
  });
}

/**
 * The interviewer prompt is a JSON block library the call code assembles at
 * runtime. A version that is not one, or that drops a block the active version
 * has, would break calls rather than change their wording, so it is refused.
 */
function checkBody(key: PromptTemplateKey, body: string, active: string | null) {
  if (!body.trim()) throw badRequest("The prompt is empty.");
  if (body.length > 200_000) throw badRequest("The prompt is too long (200,000 characters at most).");
  if (key !== "interviewer_system") return;

  const library = parseBlockLibrary(body);
  if (!library) throw badRequest('The interviewer prompt must stay a block library: JSON with "format": "pratibha.blocks/1" and "blocks".');
  const current = parseBlockLibrary(active);
  if (current) {
    const missing = Object.keys(current.blocks).filter((name) => !(name in library.blocks));
    if (missing.length) throw badRequest(`These blocks are used by the call code and cannot be removed: ${missing.join(", ")}.`);
  }
  for (const [name, text] of Object.entries(library.blocks)) {
    if (typeof text !== "string") throw badRequest(`Block "${name}" must be text.`);
  }
}

export async function savePromptVersion(admin: AdminUser, key: PromptTemplateKey, body: string, activate: boolean, note: string | null) {
  const meta = promptMeta(key);
  const normalised = body.replace(/\r\n/g, "\n");

  return db.$transaction(async (tx) => {
    const active = await tx.promptTemplate.findFirst({ where: { key, active: true }, orderBy: { version: "desc" } });
    checkBody(key, normalised, active?.body ?? null);
    if (active && active.body === normalised) throw badRequest("No changes from the active version.");

    const last = await tx.promptTemplate.findFirst({ where: { key }, orderBy: { version: "desc" }, select: { version: true } });
    const version = (last?.version ?? 0) + 1;

    if (activate) await tx.promptTemplate.updateMany({ where: { key, active: true }, data: { active: false } });
    const created = await tx.promptTemplate.create({ data: { key, version, body: normalised, active: activate } });

    await recordActivity(
      {
        actor: admin,
        action: "prompt.saved",
        summary: `${admin.name} saved ${meta.label} prompt v${version}${activate ? " and made it live" : " as a draft"}${active ? ` (live was v${active.version})` : ""}`,
        reason: note,
        before: active ? { key, version: active.version } : undefined,
        after: { key, version, active: activate },
      },
      tx
    );
    return { id: created.id, version, message: activate ? `v${version} is live.` : `Saved v${version} as a draft. It is not used until you make it live.` };
  });
}

export async function activatePromptVersion(admin: AdminUser, id: string, note: string | null) {
  return db.$transaction(async (tx) => {
    const target = await tx.promptTemplate.findUnique({ where: { id } });
    if (!target) throw notFound("No such version.");
    const meta = promptMeta(target.key);
    if (target.active) return { message: `v${target.version} is already live.` };

    const active = await tx.promptTemplate.findFirst({ where: { key: target.key, active: true }, orderBy: { version: "desc" } });
    checkBody(target.key, target.body, active?.body ?? null);

    await tx.promptTemplate.updateMany({ where: { key: target.key, active: true }, data: { active: false } });
    await tx.promptTemplate.update({ where: { id }, data: { active: true } });

    await recordActivity(
      {
        actor: admin,
        action: "prompt.activated",
        summary: `${admin.name} made ${meta.label} prompt v${target.version} live${active ? ` (was v${active.version})` : ""}`,
        reason: note,
        before: active ? { key: target.key, version: active.version } : undefined,
        after: { key: target.key, version: target.version },
      },
      tx
    );
    return { message: `v${target.version} is live.` };
  });
}
