"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { SettingDef, SettingGroupId } from "@pratibha/shared/settings-registry";
import { api } from "@/lib/client";
import { useToast } from "@/components/ui";

type Running = { source: "panel" | "env" | "default"; value: unknown } | null;

export interface SettingItem {
  def: SettingDef;
  value: unknown;
  saved: boolean;
  running: { web: Running; worker: Running };
}

const APPLIES: Record<SettingDef["applies"], { text: string; tone: string }> = {
  live: { text: "Within 30 s", tone: "chip-green" },
  next_call: { text: "Next call", tone: "chip-indigo" },
  restart: { text: "After restart", tone: "chip-amber" },
};

const APP_LABEL = { web: "Portal", worker: "Call line", admin: "Admin" } as const;

function show(def: SettingDef, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (def.type === "secret") {
    const h = v as { set?: boolean; last4?: string };
    return h.set ? `•••• ${h.last4}` : "not set";
  }
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  const o = def.options?.find((x) => x.value === v);
  return o ? o.label : String(v) || "empty";
}

/** Edit-box text for a value; lists are one entry per line. */
function toDraft(def: SettingDef, v: unknown): unknown {
  if (def.type === "list") return Array.isArray(v) ? v.join("\n") : "";
  if (def.type === "int" || def.type === "decimal") return v === null || v === undefined ? "" : String(v);
  if (def.type === "secret") return "";
  return v ?? "";
}

function fromDraft(def: SettingDef, d: unknown): unknown {
  if (def.type === "list") return String(d ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (def.type === "int" || def.type === "decimal") return String(d ?? "").trim() === "" ? "" : Number(d);
  return d;
}

export function SettingsEditor({
  items,
  groups,
  canEdit,
  canOwner,
  refusal,
  ownerRefusal,
  reportedAt,
  adminEmail,
}: {
  items: SettingItem[];
  groups: { id: SettingGroupId; label: string; blurb: string }[];
  canEdit: boolean;
  canOwner: boolean;
  refusal: string;
  ownerRefusal: string;
  reportedAt: { web: string | null; worker: string | null };
  /** Where the "Send a test email" button sends to. */
  adminEmail?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [group, setGroup] = useState<SettingGroupId>(groups[0]!.id);
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [resets, setResets] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api<{ message: string }>("/api/email/test", {});
      setTestResult({ ok: true, text: res.message });
    } catch (err) {
      setTestResult({ ok: false, text: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }

  // Deep links: /settings#billing opens that group.
  useEffect(() => {
    const id = window.location.hash.slice(1) as SettingGroupId;
    if (groups.some((g) => g.id === id)) setGroup(id);
  }, [groups]);

  const byKey = useMemo(() => Object.fromEntries(items.map((i) => [i.def.key, i])), [items]);
  const pending = Object.keys(drafts).length + resets.size;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.filter((i) => i.def.group === group);
    return items.filter((i) =>
      [i.def.label, i.def.key, i.def.help ?? "", i.def.section, i.def.env ?? ""].some((t) => t.toLowerCase().includes(q))
    );
  }, [items, group, query]);

  // Group, then section, keeping registry order.
  const sections = useMemo(() => {
    const out: { group: SettingGroupId; section: string; rows: SettingItem[] }[] = [];
    for (const item of visible) {
      const last = out[out.length - 1];
      if (last && last.group === item.def.group && last.section === item.def.section) last.rows.push(item);
      else out.push({ group: item.def.group, section: item.def.section, rows: [item] });
    }
    return out;
  }, [visible]);

  function edit(key: string, draft: unknown) {
    setDrafts((d) => ({ ...d, [key]: draft }));
    setResets((r) => {
      const n = new Set(r);
      n.delete(key);
      return n;
    });
  }
  function undo(key: string) {
    setDrafts((d) => {
      const { [key]: _, ...rest } = d;
      return rest;
    });
    setResets((r) => {
      const n = new Set(r);
      n.delete(key);
      return n;
    });
  }
  function reset(key: string) {
    undo(key);
    setResets((r) => new Set(r).add(key));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const set: Record<string, unknown> = {};
      for (const [key, d] of Object.entries(drafts)) set[key] = fromDraft(byKey[key]!.def, d);
      const res = await api<{ message: string }>("/api/settings", { set, reset: [...resets] });
      toast.show(res.message);
      setDrafts({});
      setResets(new Set());
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const changedIn = (id: SettingGroupId) => items.filter((i) => i.def.group === id && i.saved).length;
  const pendingIn = (id: SettingGroupId) =>
    items.filter((i) => i.def.group === id && (i.def.key in drafts || resets.has(i.def.key))).length;

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Platform settings</h1>
          <p className="page-sub">
            Every setting the product runs on. A value saved here beats the server&apos;s .env, which beats the built-in default.
          </p>
        </div>
        <input className="input search" placeholder="Search all settings…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search settings" />
      </div>
      {!canEdit && <div className="notice">{refusal}</div>}
      {/* Times are in the reader's zone, so the server's render differs by design. */}
      <div className="hint" suppressHydrationWarning>
        Portal last reported {reportedAt.web ? new Date(reportedAt.web).toLocaleString() : "never (not deployed yet)"} · Call line last reported{" "}
        {reportedAt.worker ? new Date(reportedAt.worker).toLocaleString() : "never (not deployed yet)"}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "236px minmax(0, 1fr)", gap: 18, alignItems: "start" }}>
        <div className="card" style={{ padding: 6, position: "sticky", top: 16 }} role="tablist" aria-label="Setting groups">
          {groups.map((g) => {
            const on = !query && g.id === group;
            const n = changedIn(g.id);
            const p = pendingIn(g.id);
            return (
              <button
                key={g.id}
                role="tab"
                aria-selected={on}
                onClick={() => {
                  setQuery("");
                  setGroup(g.id);
                  history.replaceState(null, "", `#${g.id}`);
                }}
                style={{
                  display: "flex", width: "100%", alignItems: "center", gap: 8, textAlign: "left", border: "none", cursor: "pointer",
                  padding: "9px 11px", borderRadius: 9, fontSize: 13.5,
                  background: on ? "var(--ink-strong)" : "transparent", color: on ? "#fff" : "var(--ink)", fontWeight: on ? 600 : 500,
                }}
              >
                <span style={{ flexGrow: 1 }}>{g.label}</span>
                {p > 0 && <span className="chip sm chip-amber">{p}</span>}
                {n > 0 && <span className="chip sm" style={{ background: on ? "var(--nav-active)" : "var(--chip-neutral-bg)", color: on ? "#fff" : "var(--chip-neutral)" }}>{n}</span>}
              </button>
            );
          })}
          <div className="hint" style={{ padding: "8px 11px 4px" }}>Grey count: saved here. Amber: unsaved.</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 80 }}>
          {!query && (
            <div className="hint" style={{ fontSize: 13 }}>{groups.find((g) => g.id === group)?.blurb}</div>
          )}
          {!query && group === "messages" && canEdit && (
            <div className="card card-pad" style={{ gap: 8 }}>
              <div className="card-row">
                <div className="grow">
                  <div className="card-title">Test the sender</div>
                  <div className="hint">Sends a real email to {adminEmail ?? "you"} the way Pratibha sends right now. Save your changes first.</div>
                </div>
                <button className="btn md" onClick={sendTest} disabled={testing || pending > 0}>{testing ? "Sending…" : "Send a test email"}</button>
              </div>
              {testResult && <div className={`notice ${testResult.ok ? "notice-ok" : "notice-error"}`}>{testResult.text}</div>}
            </div>
          )}
          {query && <div className="hint">{visible.length} {visible.length === 1 ? "setting matches" : "settings match"} “{query}”.</div>}
          {sections.map((s) => (
            <div className="card card-pad" key={`${s.group}/${s.section}`} style={{ gap: 0 }}>
              <div className="card-title" style={{ marginBottom: 4 }}>
                {query && <span className="cell-muted">{groups.find((g) => g.id === s.group)?.label} · </span>}
                {s.section}
              </div>
              {s.rows.map((item) => (
                <Row
                  key={item.def.key}
                  item={item}
                  draft={drafts[item.def.key]}
                  dirty={item.def.key in drafts}
                  resetting={resets.has(item.def.key)}
                  disabled={!canEdit || ((item.def.type === "secret" || Boolean(item.def.ownerOnly)) && !canOwner)}
                  lockReason={!canEdit ? refusal : ownerRefusal}
                  onEdit={(d) => edit(item.def.key, d)}
                  onUndo={() => undo(item.def.key)}
                  onReset={() => reset(item.def.key)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {canEdit && (
        <div
          className="card"
          style={{
            position: "sticky", bottom: 16, display: "flex", alignItems: "center", gap: 14, padding: "12px 18px",
            boxShadow: "0 10px 30px rgba(22, 19, 47, 0.12)", visibility: pending || error ? "visible" : "hidden",
          }}
        >
          <span className="cell-strong">{pending} unsaved {pending === 1 ? "change" : "changes"}</span>
          <span className="hint">Every change is recorded in the Activity log.</span>
          <div style={{ flexGrow: 1 }} />
          {error && <div className="error-text" role="alert">{error}</div>}
          <button className="btn md" onClick={() => { setDrafts({}); setResets(new Set()); setError(null); }} disabled={busy}>Discard</button>
          <button className="btn btn-primary md" onClick={save} disabled={busy || !pending}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      )}
      {toast.node}
    </>
  );
}

function Row({
  item,
  draft,
  dirty,
  resetting,
  disabled,
  lockReason,
  onEdit,
  onUndo,
  onReset,
}: {
  item: SettingItem;
  draft: unknown;
  dirty: boolean;
  resetting: boolean;
  disabled: boolean;
  lockReason: string;
  onEdit: (d: unknown) => void;
  onUndo: () => void;
  onReset: () => void;
}) {
  const { def, value, saved, running } = item;
  const [replacing, setReplacing] = useState(false);
  const d = dirty ? draft : toDraft(def, value);
  const applies = APPLIES[def.applies];
  const id = `s-${def.key}`;

  // What the portal/worker reported, when it disagrees with the panel (e.g. a
  // change not picked up yet, or a restart-only setting).
  const drift = (["web", "worker"] as const)
    .filter((app) => def.apps.includes(app) && running[app])
    .map((app) => ({ app, r: running[app]! }))
    .filter(({ r }) => JSON.stringify(r.value) !== JSON.stringify(value));

  const fromEnv = [running.web, running.worker].some((r) => r?.source === "env");
  const source = saved ? "Saved here" : fromEnv ? `From the server .env${def.env ? ` (${def.env})` : ""}` : "Built-in default";

  let control: ReactNode;
  if (def.key === "calls.operating_days") {
    // Stored as the worker counts them, 0 = Sunday … 6 = Saturday. Anything
    // else (a "7" from an old .env) matches no day, so it is dropped on edit.
    const on = new Set(String(d).split("\n").map((x) => x.trim()).filter((x) => /^[0-6]$/.test(x)));
    control = (
      <span style={{ display: "inline-flex", gap: 6 }}>
        {[["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"], ["0", "Sun"]].map(([day, label]) => {
          const checked = on.has(day!);
          return (
            <button key={day} type="button" className={`pill${checked ? " on" : ""}`} disabled={disabled} aria-pressed={checked}
              onClick={() => {
                const next = new Set(on);
                if (checked) next.delete(day!);
                else next.add(day!);
                onEdit([...next].sort().join("\n"));
              }}>
              {label}
            </button>
          );
        })}
      </span>
    );
  } else switch (def.type) {
    case "bool":
      control = (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input id={id} type="checkbox" checked={Boolean(d)} disabled={disabled} onChange={(e) => onEdit(e.target.checked)}
            style={{ width: 17, height: 17, accentColor: "#1E1B4B" }} />
          {d ? "On" : "Off"}
        </label>
      );
      break;
    case "select":
      control = (
        <select id={id} className="select" style={{ width: 260 }} value={String(d)} disabled={disabled} onChange={(e) => onEdit(e.target.value)}>
          {def.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case "int":
    case "decimal":
      control = (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input id={id} className={`input center${dirty ? " draft" : ""}`} style={{ width: 110 }} inputMode="decimal" value={String(d)} disabled={disabled}
            onChange={(e) => onEdit(e.target.value.replace(def.type === "int" ? /[^\d-]/g : /[^\d.-]/g, ""))} />
          {def.unit && <span className="cell-muted">{def.unit}</span>}
        </span>
      );
      break;
    case "textarea":
    case "list":
      control = (
        <textarea id={id} className={`textarea${dirty ? " input draft" : ""}`} rows={def.type === "list" ? Math.min(8, Math.max(3, String(d).split("\n").length)) : 4}
          value={String(d)} disabled={disabled} onChange={(e) => onEdit(e.target.value)}
          placeholder={def.type === "list" ? "One per line" : "Empty uses the built-in wording"} />
      );
      break;
    case "secret":
      control = replacing || dirty ? (
        <span style={{ display: "inline-flex", gap: 8, width: "100%" }}>
          <input id={id} className="input draft" type="password" autoComplete="off" autoFocus placeholder="Paste the new key" value={String(d ?? "")}
            disabled={disabled} onChange={(e) => onEdit(e.target.value)} />
          <button className="btn sm" type="button" onClick={() => { setReplacing(false); onUndo(); }}>Cancel</button>
        </span>
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span className="mono">{show(def, value)}</span>
          <button className="btn sm" type="button" disabled={disabled} onClick={() => setReplacing(true)}>
            {(value as { set?: boolean })?.set ? "Replace key" : "Add key"}
          </button>
        </span>
      );
      break;
    default:
      control = (
        <input id={id} className={`input${dirty ? " draft" : ""}`} value={String(d)} disabled={disabled} onChange={(e) => onEdit(e.target.value)} />
      );
  }

  const wide = def.key !== "calls.operating_days" && (def.type === "textarea" || def.type === "list" || def.type === "text" || def.type === "secret");

  return (
    <div style={{ borderTop: "1px solid var(--line-soft)", padding: "13px 0", display: "grid", gridTemplateColumns: wide ? "minmax(0, 1fr)" : "minmax(0, 1fr) auto", gap: wide ? 8 : 18, alignItems: "start" }}>
      <div style={{ minWidth: 0 }}>
        <label htmlFor={id} className="cell-strong" style={{ fontSize: 13.5 }}>{def.label}</label>
        {def.help && <div className="hint" style={{ marginTop: 2 }}>{def.help}</div>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, alignItems: "center" }}>
          <span className={`chip sm ${applies.tone}`}>{applies.text}</span>
          {def.apps.map((a) => <span key={a} className="chip sm chip-neutral">{APP_LABEL[a]}</span>)}
          {(def.ownerOnly || def.type === "secret") && <span className="chip sm chip-red">Owner only</span>}
          <span className="cell-muted" style={{ fontSize: 11.5 }}>
            {resetting ? "Will reset to the server default" : source}
            {saved && !resetting && !disabled && (
              <> · <button type="button" onClick={onReset} style={{ background: "none", border: "none", padding: 0, color: "var(--amber-link)", cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}>Reset to default</button></>
            )}
            {(dirty || resetting) && (
              <> · <button type="button" onClick={() => { setReplacing(false); onUndo(); }} style={{ background: "none", border: "none", padding: 0, color: "var(--amber-link)", cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}>Undo</button></>
            )}
          </span>
          {drift.map(({ app, r }) => (
            <span key={app} className="chip sm chip-amber" title="What that app last reported running with">
              {APP_LABEL[app]} running: {show(def, r.value)}
            </span>
          ))}
        </div>
        {disabled && <div className="hint" style={{ marginTop: 4 }} title={lockReason}>🔒 {lockReason}</div>}
      </div>
      <div style={{ minWidth: wide ? 0 : 120, display: "flex", justifyContent: wide ? "stretch" : "flex-end" }}>{control}</div>
    </div>
  );
}
