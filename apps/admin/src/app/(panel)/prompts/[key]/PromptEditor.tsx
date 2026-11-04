"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useToast } from "@/components/ui";

interface Version {
  id: string;
  version: number;
  active: boolean;
  createdAt: string;
  body: string;
}

interface Meta {
  key: string;
  label: string;
  usedFor: string;
  app: string;
  json: boolean;
}

type Library = { format: string; blocks: Record<string, string>; [k: string]: unknown };

function parseLibrary(body: string): Library | null {
  try {
    const doc = JSON.parse(body);
    if (doc?.format === "pratibha.blocks/1" && doc.blocks && typeof doc.blocks === "object") return doc;
  } catch {
    // not a block library
  }
  return null;
}

/** Line diff by longest common subsequence: small prompts, so O(n·m) is fine. */
function diffLines(a: string, b: string): { op: " " | "-" | "+"; text: string }[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  if (n * m > 4_000_000) return [{ op: " ", text: "Too large to compare line by line." }];
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: { op: " " | "-" | "+"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: " ", text: x[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "-", text: x[i++]! });
    else out.push({ op: "+", text: y[j++]! });
  }
  while (i < n) out.push({ op: "-", text: x[i++]! });
  while (j < m) out.push({ op: "+", text: y[j++]! });
  return out;
}

/** Pretty JSON so a block library diffs block by block, not as one long line. */
function canonical(body: string, json: boolean) {
  if (!json) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function PromptEditor({ meta, versions, canEdit, refusal }: { meta: Meta; versions: Version[]; canEdit: boolean; refusal: string }) {
  const router = useRouter();
  const toast = useToast();
  const live = versions.find((v) => v.active) ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(live?.id ?? versions[0]?.id ?? null);
  const selected = versions.find((v) => v.id === selectedId) ?? null;

  const [text, setText] = useState(selected?.body ?? "");
  const [raw, setRaw] = useState(false);
  const [compare, setCompare] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const library = meta.json && !raw ? parseLibrary(text) : null;
  const dirty = selected ? text !== selected.body : text.trim().length > 0;

  function pick(v: Version) {
    if (dirty && !window.confirm("Discard your unsaved edits?")) return;
    setSelectedId(v.id);
    setText(v.body);
    setError(null);
  }

  function setBlock(name: string, value: string) {
    if (!library) return;
    setText(JSON.stringify({ ...library, blocks: { ...library.blocks, [name]: value } }, null, 2));
  }

  const diff = useMemo(
    () => (compare && live ? diffLines(canonical(live.body, meta.json), canonical(text, meta.json)) : []),
    [compare, live, text, meta.json]
  );
  const changedLines = diff.filter((d) => d.op !== " ").length;

  async function save(activate: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string; id: string }>(`/api/prompts/${meta.key}`, { body: text, activate, note: note || undefined });
      toast.show(res.message);
      setNote("");
      setSelectedId(res.id);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makeLive(v: Version) {
    if (!window.confirm(`Make v${v.version} the live ${meta.label} prompt? The current live version stays in the history.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>(`/api/prompts/versions/${v.id}/activate`, { note: note || undefined });
      toast.show(res.message);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">{meta.label} prompt</h1>
          <p className="page-sub">{meta.usedFor} Used by the {meta.app}.</p>
        </div>
      </div>
      {!canEdit && <div className="notice">{refusal}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0, 1fr)", gap: 18, alignItems: "start" }}>
        <div className="card" style={{ padding: 6, position: "sticky", top: 16, maxHeight: "80vh", overflow: "auto" }}>
          <div className="label" style={{ padding: "8px 10px 4px" }}>Versions</div>
          {versions.length === 0 && <div className="hint" style={{ padding: 10 }}>No versions yet.</div>}
          {versions.map((v) => {
            const on = v.id === selectedId;
            return (
              <button key={v.id} onClick={() => pick(v)} style={{
                display: "flex", width: "100%", gap: 8, alignItems: "center", textAlign: "left", border: "none", cursor: "pointer",
                padding: "8px 10px", borderRadius: 9, background: on ? "var(--ink-strong)" : "transparent", color: on ? "#fff" : "var(--ink)",
              }}>
                <span style={{ fontWeight: 600 }}>v{v.version}</span>
                <span style={{ flexGrow: 1, fontSize: 12, opacity: 0.8 }} suppressHydrationWarning>{new Date(v.createdAt).toLocaleDateString()}</span>
                {v.active ? <span className="chip sm chip-green">Live</span> : live && v.version > live.version ? <span className="chip sm chip-amber">Draft</span> : null}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card card-pad">
            <div className="card-row">
              <div className="grow card-title">
                {selected ? `Editing from v${selected.version}` : "New prompt"}
                {selected?.active && <span className="cell-muted"> · live</span>}
              </div>
              {meta.json && (
                <label className="cell-muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Raw JSON
                </label>
              )}
              {live && (
                <label className="cell-muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare with live
                </label>
              )}
            </div>

            {compare && live ? (
              <div className="mono" style={{ fontSize: 12.5, border: "1px solid var(--line)", borderRadius: 10, overflow: "auto", maxHeight: "65vh" }}>
                {changedLines === 0 && <div style={{ padding: 12 }} className="hint">Identical to the live version (v{live.version}).</div>}
                {diff.map((d, i) => (
                  <div key={i} style={{
                    whiteSpace: "pre-wrap", padding: "1px 10px",
                    background: d.op === "+" ? "var(--green-bg)" : d.op === "-" ? "var(--red-bg)" : undefined,
                    color: d.op === "+" ? "var(--green)" : d.op === "-" ? "var(--red)" : "var(--ink-body)",
                  }}>
                    {d.op} {d.text}
                  </div>
                ))}
              </div>
            ) : library ? (
              Object.entries(library.blocks).map(([name, value]) => (
                <div className="field" key={name}>
                  <label className="label mono" htmlFor={`b-${name}`}>{name}</label>
                  <textarea id={`b-${name}`} className="textarea" rows={Math.min(18, Math.max(3, String(value).split("\n").length + 1))}
                    value={String(value)} onChange={(e) => setBlock(name, e.target.value)} disabled={!canEdit} />
                </div>
              ))
            ) : (
              <textarea className="textarea mono" style={{ minHeight: "55vh", fontSize: 12.5 }} value={text} onChange={(e) => setText(e.target.value)} disabled={!canEdit} />
            )}
          </div>

          {canEdit && (
            <div className="card card-pad">
              <div className="field">
                <label className="label" htmlFor="note">What changed and why (kept in the Activity log)</label>
                <input id="note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Optional" />
              </div>
              <div className="card-row">
                {error && <div className="error-text grow" role="alert">{error}</div>}
                {!error && <div className="grow hint">{dirty ? "Unsaved edits. Saving always creates a new version." : "No edits yet."}</div>}
                {selected && !selected.active && !dirty && (
                  <button className="btn md" onClick={() => makeLive(selected)} disabled={busy}>
                    {live && selected.version < live.version ? `Roll back to v${selected.version}` : `Make v${selected.version} live`}
                  </button>
                )}
                <button className="btn md" onClick={() => save(false)} disabled={busy || !dirty}>Save as draft</button>
                <button className="btn btn-primary md" onClick={() => save(true)} disabled={busy || !dirty}>{busy ? "Saving…" : "Save and make live"}</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {toast.node}
    </>
  );
}
