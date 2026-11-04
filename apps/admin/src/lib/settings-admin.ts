import type { AdminUser, Prisma } from "@pratibha/prisma";
import { sealSecret } from "@pratibha/shared/crypto";
import { refreshSettings } from "@pratibha/shared/settings-runtime";
import { SETTINGS_BY_KEY, validateSettingValue, type SettingDef } from "@pratibha/shared/settings-registry";
import { db } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import { badRequest, forbidden } from "@/lib/http";
import { can, refusalReason } from "@/lib/auth/roles";
import { getSettings } from "@/lib/settings";

/**
 * Save Platform settings.
 *
 * The body is `{ set: { key: value }, reset: [key] }`. A reset deletes the
 * saved row, so the key falls back to the server's .env or the default. The
 * portal and the worker pick changes up within about 30 seconds. Every change
 * is one Activity row with the old and new value; for secrets only the last
 * four characters are ever recorded.
 */
export interface SaveSettingsInput {
  set?: Record<string, unknown>;
  reset?: string[];
}

function needsOwner(def: SettingDef) {
  return def.type === "secret" || Boolean(def.ownerOnly);
}

function fmt(def: SettingDef, v: unknown): string {
  if (v === null || v === undefined) return "default";
  if (def.type === "secret") {
    const hint = v as { set?: boolean; last4?: string };
    return hint.set ? `a key ending ${hint.last4}` : "not set";
  }
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  const option = def.options?.find((o) => o.value === v);
  if (option) return option.label;
  const text = String(v);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text || "empty";
}

export async function saveSettings(admin: AdminUser, input: SaveSettingsInput) {
  const set = input.set ?? {};
  const reset = input.reset ?? [];
  const current = await getSettings();

  type Change = { def: SettingDef; from: unknown; to: unknown; stored: Prisma.InputJsonValue | null };
  const changes: Change[] = [];

  for (const [key, raw] of Object.entries(set)) {
    const def = SETTINGS_BY_KEY[key];
    if (!def) throw badRequest(`Unknown setting ${key}.`);
    if (needsOwner(def) && !can(admin.role, "settings.owner")) throw forbidden(refusalReason(admin.role, "settings.owner"));

    const checked = validateSettingValue(def, raw);
    if (!checked.ok) throw badRequest(checked.error);

    if (def.type === "secret") {
      const plain = checked.value as string;
      let sealed: string;
      try {
        sealed = sealSecret(plain);
      } catch {
        throw badRequest("This server cannot encrypt keys yet: EMAIL_SECRET_KEY is missing from the admin panel's environment.");
      }
      const last4 = plain.slice(-4);
      changes.push({ def, from: current[key], to: { set: true, last4 }, stored: { sealed, last4 } });
    } else if (JSON.stringify(checked.value) !== JSON.stringify(current[key])) {
      changes.push({ def, from: current[key], to: checked.value, stored: checked.value as Prisma.InputJsonValue });
    }
  }

  for (const key of reset) {
    const def = SETTINGS_BY_KEY[key];
    if (!def) throw badRequest(`Unknown setting ${key}.`);
    if (key in set) continue;
    if (needsOwner(def) && !can(admin.role, "settings.owner")) throw forbidden(refusalReason(admin.role, "settings.owner"));
    changes.push({ def, from: current[key], to: null, stored: null });
  }

  if (!changes.length) return { message: "Nothing changed." };

  await db.$transaction(async (tx) => {
    for (const c of changes) {
      if (c.stored === null) {
        await tx.platformSetting.deleteMany({ where: { key: c.def.key } });
      } else {
        await tx.platformSetting.upsert({
          where: { key: c.def.key },
          update: { value: c.stored, updatedBy: admin.id },
          create: { key: c.def.key, value: c.stored, updatedBy: admin.id },
        });
      }
      await recordActivity(
        {
          actor: admin,
          action: "settings.changed",
          summary:
            c.to === null
              ? `${admin.name} reset ${c.def.label} to the server default`
              : `${admin.name} changed ${c.def.label}: ${fmt(c.def, c.from)} to ${fmt(c.def, c.to)}`,
          // For a secret, from/to are only { set, last4 }: never the key itself.
          before: { key: c.def.key, value: (c.from ?? null) as Prisma.InputJsonValue },
          after: { key: c.def.key, value: (c.to === null ? "default" : c.to) as Prisma.InputJsonValue },
        },
        tx
      );
    }
  });

  // This app's own copy applies now rather than at the next 30-second refresh.
  await refreshSettings().catch(() => {});

  const n = changes.length;
  return { message: `Saved ${n} ${n === 1 ? "change" : "changes"}. The portal and the call line pick them up within about 30 seconds.` };
}
