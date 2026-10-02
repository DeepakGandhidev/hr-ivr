import type { AdminUser, Prisma } from "@pratibha/prisma";
import { db } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import { badRequest } from "@/lib/http";
import { getSettings, GATE_OPTIONS, type SettingKey } from "@/lib/settings";

/**
 * The keys the Platform settings page edits: the designed eight, and nothing
 * else. The portal reads the same rows, so a change applies on the next screen
 * load in every workspace, without a deploy. Every change is one log row per
 * key, with the old and the new value.
 */
export const EDITABLE: { key: SettingKey; label: string; kind: "int" | "decimal" | "bool" | "gate"; min?: number; max?: number }[] = [
  { key: "screening.suggest_threshold", label: "Suggest for shortlist at score", kind: "int", min: 1, max: 100 },
  { key: "pipeline.junk_hint", label: "Junk hint on the Pipeline", kind: "bool" },
  { key: "report.score_gap_threshold", label: "Score gap badge from", kind: "decimal", min: 0.5, max: 10 },
  { key: "interview.screener_seconds", label: "Estimated seconds per screener", kind: "int", min: 5, max: 300 },
  { key: "lists.page_size", label: "Rows per page", kind: "int", min: 10, max: 200 },
  { key: "company.description_cap", label: "Description length cap", kind: "int", min: 100, max: 5000 },
  { key: "gate.portal_posts", label: "Portal posts, Naukri and LinkedIn", kind: "gate" },
  { key: "gate.interview_tuning", label: "Interview tuning: screeners, salary policy, custom questions", kind: "gate" },
];

export async function saveSettings(admin: AdminUser, input: Record<string, unknown>) {
  const current = await getSettings();
  const changes: { key: SettingKey; label: string; from: unknown; to: unknown }[] = [];

  for (const def of EDITABLE) {
    if (!(def.key in input)) continue;
    const raw = input[def.key];
    let value: unknown;
    if (def.kind === "bool") {
      if (typeof raw !== "boolean") throw badRequest(`${def.label}: choose on or off.`);
      value = raw;
    } else if (def.kind === "gate") {
      if (!GATE_OPTIONS.some((g) => g.value === raw)) throw badRequest(`${def.label}: choose one of the options.`);
      value = raw;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || (def.kind === "int" && !Number.isInteger(n))) throw badRequest(`${def.label}: enter a ${def.kind === "int" ? "whole " : ""}number.`);
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        throw badRequest(`${def.label}: between ${def.min} and ${def.max}.`);
      }
      value = def.kind === "decimal" ? Math.round(n * 10) / 10 : n;
    }
    if (value !== current[def.key]) changes.push({ key: def.key, label: def.label, from: current[def.key], to: value });
  }

  if (!changes.length) return { message: "Nothing changed." };

  await db.$transaction(async (tx) => {
    for (const c of changes) {
      await tx.platformSetting.upsert({
        where: { key: c.key },
        update: { value: c.to as Prisma.InputJsonValue, updatedBy: admin.id },
        create: { key: c.key, value: c.to as Prisma.InputJsonValue, updatedBy: admin.id },
      });
      await recordActivity(
        {
          actor: admin,
          action: "settings.changed",
          summary: `${admin.name} changed ${c.label}: ${fmt(c.from)} to ${fmt(c.to)}`,
          before: { key: c.key, value: c.from },
          after: { key: c.key, value: c.to },
        },
        tx
      );
    }
  });
  return { message: `Saved ${changes.length} ${changes.length === 1 ? "change" : "changes"}. They apply on every workspace's next screen load.` };
}

function fmt(v: unknown) {
  if (typeof v === "boolean") return v ? "on" : "off";
  const gate = GATE_OPTIONS.find((g) => g.value === v);
  return gate ? gate.label : String(v);
}
