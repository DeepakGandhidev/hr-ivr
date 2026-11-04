"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useToast } from "@/components/ui";
import type { EntryView, PublishView } from "@/lib/website/store";

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

type Kind = "page" | "company" | "testimonial" | "faq" | "post";

type FieldSpec = {
  name: string;
  label: string;
  type?: "text" | "textarea" | "checkbox" | "select" | "markdown" | "image";
  /** Recommended length: the counter turns amber past it (not a hard limit). */
  max?: number;
  rows?: number;
  hint?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
};

function getPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj: any, path: string, value: unknown): any {
  const [head, ...rest] = path.split(".");
  const copy = { ...(obj ?? {}) };
  copy[head!] = rest.length ? setPath(copy[head!], rest.join("."), value) : value;
  return copy;
}

function useWebsiteAction() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(body: Record<string, unknown>, after?: (res: any) => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await api("/api/website", body);
      toast.show(res.message ?? "Done.");
      after?.(res);
      router.refresh();
      return res;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, toast: toast.node };
}

function StateChips({ entry }: { entry: Pick<EntryView<unknown>, "isNew" | "removed" | "changed"> }) {
  if (entry.removed) return <span className="chip sm chip-red">Removing on publish</span>;
  if (entry.isNew) return <span className="chip sm chip-amber">New, not published</span>;
  if (entry.changed) return <span className="chip sm chip-amber">Unpublished changes</span>;
  return <span className="chip sm chip-green">Live</span>;
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

const MAX_BYTES = 900_000; // under the admin host's 1 MB upload limit
const MAX_EDGE = 1600;

/** Shrink to at most 1600 px on the long edge and re-encode (WebP, else JPEG) until it fits. */
async function prepareImage(file: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("Use a PNG, JPG or WebP image.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_BYTES) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const encode = (type: string, q: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, q));
  for (const q of [0.86, 0.76, 0.66, 0.55, 0.45]) {
    let blob = await encode("image/webp", q);
    // Browsers that cannot write WebP hand back a PNG; use JPEG there.
    if (!blob || blob.type !== "image/webp") blob = await encode("image/jpeg", q);
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error("This image is too large even after shrinking it. Try a smaller one.");
}

async function uploadImage(file: File): Promise<string> {
  const blob = await prepareImage(file);
  const res = await fetch("/api/website/upload", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.href = "/sign-in?expired=1";
    throw new Error("Your session has ended.");
  }
  if (!res.ok) throw new Error(data?.message ?? "The upload failed.");
  return data.path as string;
}

/** Where the panel can show an image from: its own copy for uploads not yet published. */
function previewSrc(v: string) {
  if (v.startsWith("/uploads/")) return `/api/website/upload?file=${encodeURIComponent(v.slice("/uploads/".length))}`;
  if (v.startsWith("/")) return `https://pratibha.tech${v}`;
  return v;
}

function ImageField({ id, label, hint, value, disabled, onChange }: { id: string; label: string; hint?: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pick(file?: File) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await uploadImage(file));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div
          style={{ width: 120, height: 80, borderRadius: 10, border: "1px solid var(--line-soft)", background: "#f6f5f1", overflow: "hidden", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewSrc(value)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span className="hint">No image</span>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flexGrow: 1 }}>
          <div className="toolbar">
            <button className="btn sm" type="button" disabled={disabled || busy} onClick={() => input.current?.click()}>
              {busy ? "Uploading…" : value ? "Replace image" : "Upload image"}
            </button>
            {value && (
              <button className="btn sm" type="button" disabled={disabled || busy} onClick={() => onChange("")}>Remove</button>
            )}
          </div>
          <input id={id} className="input" value={value} disabled={disabled} placeholder="…or paste an https:// address" onChange={(e) => onChange(e.target.value)} />
        </div>
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
      {error && <span className="error-text">{error}</span>}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** The article editor, with an Insert image button that puts Markdown at the cursor. */
function MarkdownField({ id, rows, value, disabled, onChange }: { id: string; rows?: number; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function insert(file?: File) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const path = await uploadImage(file);
      const alt = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/[\[\]]/g, "").trim() || "Image";
      const at = area.current?.selectionStart ?? value.length;
      const snippet = `\n\n![${alt}](${path})\n\n`;
      onChange(value.slice(0, at) + snippet + value.slice(at));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <>
      <div className="toolbar">
        <button className="btn sm" type="button" disabled={disabled || busy} onClick={() => input.current?.click()}>
          {busy ? "Uploading…" : "Insert image"}
        </button>
        <span className="hint">Goes in where the cursor is. Edit the text in [ ] to describe the image.</span>
      </div>
      <textarea
        ref={area}
        id={id}
        className="textarea"
        rows={rows ?? 12}
        value={value ?? ""}
        disabled={disabled}
        style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13 }}
        onChange={(e) => onChange(e.target.value)}
      />
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => insert(e.target.files?.[0])} />
      {error && <span className="error-text">{error}</span>}
    </>
  );
}

function Fields({ fields, value, onChange, disabled }: { fields: FieldSpec[]; value: any; onChange: (v: any) => void; disabled: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {fields.map((f) => {
        const v = getPath(value, f.name);
        const id = `f-${f.name}`;
        const count = typeof v === "string" && f.max ? (
          <span className="hint" style={{ color: v.length > f.max ? "var(--amber-ink)" : undefined }}>
            {v.length}/{f.max}{v.length > f.max ? " · may be cut off in search results" : ""}
          </span>
        ) : null;
        if (f.type === "image") {
          return (
            <ImageField key={f.name} id={id} label={f.label} hint={f.hint} value={v ?? ""} disabled={disabled} onChange={(nv) => onChange(setPath(value, f.name, nv))} />
          );
        }
        if (f.type === "checkbox") {
          return (
            <label key={f.name} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5 }}>
              <input type="checkbox" checked={Boolean(v)} disabled={disabled} onChange={(e) => onChange(setPath(value, f.name, e.target.checked))} />
              {f.label}
              {f.hint && <span className="hint">· {f.hint}</span>}
            </label>
          );
        }
        return (
          <div key={f.name} className="field">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <label className="label" htmlFor={id}>{f.label}</label>
              {count}
            </div>
            {f.type === "select" ? (
              <select id={id} className="select" value={v ?? ""} disabled={disabled} onChange={(e) => onChange(setPath(value, f.name, e.target.value))}>
                {f.options!.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : f.type === "markdown" ? (
              <MarkdownField id={id} rows={f.rows} value={v ?? ""} disabled={disabled} onChange={(nv) => onChange(setPath(value, f.name, nv))} />
            ) : f.type === "textarea" ? (
              <textarea
                id={id}
                className="textarea"
                rows={f.rows ?? 3}
                value={v ?? ""}
                disabled={disabled}
                placeholder={f.placeholder}
                onChange={(e) => onChange(setPath(value, f.name, e.target.value))}
              />
            ) : (
              <input id={id} className="input" value={v ?? ""} disabled={disabled} placeholder={f.placeholder} onChange={(e) => onChange(setPath(value, f.name, e.target.value))} />
            )}
            {f.hint && <span className="hint">{f.hint}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** One editable item: its form, Save, Discard changes, and optional Remove / move. */
function ItemCard<T>({
  kind,
  entry,
  title,
  fields,
  canEdit,
  movable,
  removable,
  defaultOpen,
  extra,
}: {
  kind: Kind;
  entry: EntryView<T>;
  title: string;
  fields: FieldSpec[];
  canEdit: boolean;
  movable?: boolean;
  removable?: boolean;
  defaultOpen?: boolean;
  extra?: (draft: any) => React.ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [draft, setDraft] = useState<any>(entry.data);
  const { busy, error, run, toast } = useWebsiteAction();
  useEffect(() => setDraft(entry.data), [entry.data]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(entry.data);
  const disabled = !canEdit || busy || entry.removed;

  return (
    <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card-row" style={{ gap: 10 }}>
        <button type="button" className="grow" onClick={() => setOpen(!open)} style={{ all: "unset", cursor: "pointer", flexGrow: 1, fontWeight: 600, fontSize: 14 }}>
          {open ? "▾" : "▸"} {title}
        </button>
        <StateChips entry={entry} />
        {movable && canEdit && (
          <>
            <button className="btn sm" type="button" disabled={busy} onClick={() => run({ action: "move", kind, key: entry.key, direction: "up" })} aria-label="Move up">↑</button>
            <button className="btn sm" type="button" disabled={busy} onClick={() => run({ action: "move", kind, key: entry.key, direction: "down" })} aria-label="Move down">↓</button>
          </>
        )}
      </div>
      {open && (
        <>
          <Fields fields={fields} value={draft} onChange={setDraft} disabled={disabled} />
          {extra?.(draft)}
          {error && <div className="error-text">{error}</div>}
          {canEdit && (
            <div className="toolbar">
              <button className="btn btn-primary md" type="button" disabled={disabled || !dirty} onClick={() => run({ action: "save", kind, key: entry.key, data: draft })}>
                Save draft
              </button>
              {(entry.changed || entry.removed) && !entry.isNew && (
                <button className="btn md" type="button" disabled={busy} onClick={() => run({ action: "discard", kind, key: entry.key })}>
                  {entry.removed ? "Keep it" : "Discard changes"}
                </button>
              )}
              <span className="grow" />
              {removable && !entry.removed && (
                <button
                  className="btn btn-danger md"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Remove "${title}"?`)) void run({ action: "remove", kind, key: entry.key });
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          )}
        </>
      )}
      {toast}
    </div>
  );
}

/** "Add" form for list items. */
function AddCard({ kind, fields, initial, label, canEdit }: { kind: Kind; fields: FieldSpec[]; initial: any; label: string; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<any>(initial);
  const { busy, error, run, toast } = useWebsiteAction();
  if (!canEdit) return null;
  if (!open) {
    return (
      <div>
        <button className="btn md" type="button" onClick={() => setOpen(true)}>+ {label}</button>
      </div>
    );
  }
  return (
    <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card-title">{label}</div>
      <Fields fields={fields} value={draft} onChange={setDraft} disabled={busy} />
      {error && <div className="error-text">{error}</div>}
      <div className="toolbar">
        <button
          className="btn btn-primary md"
          type="button"
          disabled={busy}
          onClick={() =>
            run({ action: "save", kind, data: draft }, () => {
              setDraft(initial);
              setOpen(false);
            })
          }
        >
          Add as draft
        </button>
        <button className="btn md" type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {toast}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Publish bar                                                         */
/* ------------------------------------------------------------------ */

function ago(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function PublishBar({
  pending,
  publishes,
  canPublish,
  refusal,
  configured,
  siteUrl,
}: {
  pending: number;
  publishes: PublishView[];
  canPublish: boolean;
  refusal: string;
  configured: boolean;
  siteUrl: string;
}) {
  const router = useRouter();
  const { busy, error, run, toast } = useWebsiteAction();
  const latest = publishes[0];
  const building = latest?.status === "building";

  useEffect(() => {
    if (!building || !latest) return;
    const t = setInterval(async () => {
      try {
        const s = await api(`/api/website/status?id=${latest.id}`, undefined, "GET");
        if (s.status !== "building") router.refresh();
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [building, latest, router]);

  return (
    <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="toolbar">
        <div className="grow">
          <div className="card-title">
            {building ? "Publishing…" : pending ? `${pending} unpublished ${pending === 1 ? "change" : "changes"}` : "Everything is published"}
          </div>
          <div className="hint">
            {building
              ? "Building the website. This takes about a minute; you can leave this page."
              : latest
                ? `Last publish ${ago(latest.startedAt)}${latest.startedBy ? ` by ${latest.startedBy}` : ""}: ${latest.status === "live" ? "live" : "failed"}.`
                : "Drafts you save here reach pratibha.tech when you publish."}
          </div>
        </div>
        <a className="btn md" href={siteUrl} target="_blank" rel="noreferrer">View site ↗</a>
        {latest?.status === "failed" && canPublish && (
          <button className="btn md" type="button" disabled={busy} onClick={() => run({ action: "retry" })}>Retry build</button>
        )}
        <button
          className="btn btn-primary md"
          type="button"
          disabled={busy || building || !pending || !canPublish || !configured}
          title={!canPublish ? refusal : !configured ? "Publishing is not set up on this server." : undefined}
          onClick={() => {
            if (confirm(`Publish ${pending} ${pending === 1 ? "change" : "changes"} to pratibha.tech?`)) void run({ action: "publish" });
          }}
        >
          Publish
        </button>
      </div>
      {!configured && <div className="notice">Publishing is not set up on this server yet (SITE_PUBLISH_SCRIPT). Drafts still save.</div>}
      {error && <div className="notice notice-error">{error}</div>}
      {latest?.status === "failed" && (
        <details>
          <summary className="hint" style={{ cursor: "pointer" }}>The last build failed; the website still shows the version before it. Show the build log</summary>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 280, overflow: "auto", marginTop: 8 }}>{latest.log ?? "No output."}</pre>
        </details>
      )}
      {toast}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

const PAGE_FIELDS: FieldSpec[] = [
  { name: "title", label: "Title", max: 60, hint: "Shown in Google and the browser tab. Pages other than Home get \" | Pratibha\" added." },
  { name: "description", label: "Meta description", type: "textarea", rows: 2, max: 160, hint: "The snippet under the title in search results, and the text on link previews." },
  { name: "ogImage", label: "Share image (optional)", type: "image", hint: "Image for WhatsApp, LinkedIn and X previews. 1200×630 works best." },
  { name: "inSitemap", label: "Let search engines index this page", type: "checkbox", hint: "Off adds noindex and leaves it out of the sitemap." },
];

export function PagesSection({ pages, labels, canEdit }: { pages: EntryView<any>[]; labels: Record<string, { label: string; path: string }>; canEdit: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {pages.map((p) => (
        <ItemCard
          key={p.key}
          kind="page"
          entry={p}
          title={`${labels[p.key]?.label ?? p.key}  ·  ${labels[p.key]?.path ?? ""}`}
          fields={PAGE_FIELDS}
          canEdit={canEdit}
          extra={(d) => (
            <div style={{ border: "1px solid var(--line-soft)", borderRadius: 10, padding: "10px 14px" }}>
              <div className="hint">Search preview</div>
              <div style={{ color: "#1a0dab", fontSize: 17, marginTop: 2 }}>
                {p.key === "home" ? d?.title : `${d?.title ?? ""} | Pratibha`}
              </div>
              <div style={{ color: "#006621", fontSize: 12.5 }}>pratibha.tech{labels[p.key]?.path === "/" ? "" : labels[p.key]?.path}</div>
              <div style={{ color: "#545454", fontSize: 13 }}>{d?.description}</div>
            </div>
          )}
        />
      ))}
    </div>
  );
}

const COMPANY_FIELDS: FieldSpec[] = [
  { name: "brandName", label: "Brand name" },
  { name: "legalName", label: "Legal name" },
  { name: "llpin", label: "LLPIN", hint: "Left out of the legal pages while empty." },
  { name: "registeredOffice", label: "Registered office", type: "textarea", rows: 2 },
  { name: "operatingOffice", label: "Operating office", type: "textarea", rows: 2 },
  { name: "email", label: "Contact email" },
  { name: "phone", label: "Phone" },
  { name: "grievanceOfficer.name", label: "Grievance officer: name", hint: "Shown on the legal pages once name and designation are both filled in." },
  { name: "grievanceOfficer.designation", label: "Grievance officer: designation" },
  { name: "grievanceOfficer.email", label: "Grievance officer: email (optional)" },
  { name: "jurisdiction", label: "Courts with jurisdiction (Terms of Service)", placeholder: "Gurugram, Haryana" },
];

export function CompanySection({ company, canEdit }: { company: EntryView<any> | null; canEdit: boolean }) {
  if (!company) return <div className="card empty"><strong>No company details yet</strong>Run the website import on the server.</div>;
  return <ItemCard kind="company" entry={company} title="Company and legal details" fields={COMPANY_FIELDS} canEdit={canEdit} defaultOpen />;
}

const TESTIMONIAL_FIELDS: FieldSpec[] = [
  { name: "quote", label: "Quote", type: "textarea", rows: 4, max: 600 },
  { name: "name", label: "Name" },
  { name: "role", label: "Role and company", placeholder: "Founder, Linkfit" },
  { name: "photo", label: "Photo (optional)", type: "image", hint: "A square photo works best." },
];

export function TestimonialsSection({ items, canEdit }: { items: EntryView<any>[]; canEdit: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="notice">Only add real quotes from real customers, with their permission. The homepage hides this section while the list is empty.</div>
      {items.length === 0 && <div className="card empty"><strong>No testimonials</strong>The homepage doesn&apos;t show the section.</div>}
      {items.map((t) => (
        <ItemCard key={t.key} kind="testimonial" entry={t} title={`${t.data?.name ?? "Removed"}: ${t.data?.role ?? ""}`} fields={TESTIMONIAL_FIELDS} canEdit={canEdit} movable removable />
      ))}
      <AddCard kind="testimonial" fields={TESTIMONIAL_FIELDS} initial={{ quote: "", name: "", role: "" }} label="Add testimonial" canEdit={canEdit} />
    </div>
  );
}

const FAQ_FIELDS: FieldSpec[] = [
  { name: "question", label: "Question", max: 200 },
  { name: "answer", label: "Answer", type: "textarea", rows: 4, hint: "Plain text. A blank line starts a new paragraph." },
];

export function FaqSection({ items, canEdit }: { items: EntryView<any>[]; canEdit: boolean }) {
  const groups = [
    { id: "home", label: "Homepage FAQ" },
    { id: "pricing", label: "Pricing page FAQ" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {groups.map((g) => {
        const list = items.filter((i) => i.data?.group === g.id);
        return (
          <div key={g.id} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="card-title">{g.label}</div>
            {list.map((f) => (
              <ItemCard key={f.key} kind="faq" entry={f} title={f.data?.question ?? "Removed"} fields={FAQ_FIELDS} canEdit={canEdit} movable removable />
            ))}
            <AddCard kind="faq" fields={FAQ_FIELDS} initial={{ question: "", answer: "", group: g.id }} label={`Add a question to the ${g.label.toLowerCase()}`} canEdit={canEdit} />
          </div>
        );
      })}
    </div>
  );
}

const STATUS_OPTIONS = [
  { value: "draft", label: "Hidden (draft)" },
  { value: "coming_soon", label: "Coming soon (card only, no article page)" },
  { value: "published", label: "Published (card and article page)" },
];

const POST_FIELDS: FieldSpec[] = [
  { name: "title", label: "Title", max: 140 },
  { name: "slug", label: "URL", hint: "pratibha.tech/blog/<this>. Lowercase letters, digits and hyphens. Changing it after publishing breaks old links." },
  { name: "status", label: "Status", type: "select", options: STATUS_OPTIONS },
  { name: "excerpt", label: "Excerpt", type: "textarea", rows: 2, max: 300, hint: "Shown on the blog card." },
  { name: "category", label: "Category", placeholder: "Guides" },
  { name: "readTime", label: "Read time", placeholder: "8 min read" },
  { name: "author", label: "Author (optional)" },
  { name: "image", label: "Cover image (optional)", type: "image", hint: "Shown on the blog card and at the top of the article. Landscape, about 1600×900." },
  { name: "body", label: "Article (Markdown)", type: "markdown", rows: 18, hint: "## for headings, **bold**, [link](https://…), - for lists, blank line between paragraphs. Insert image adds a picture." },
  { name: "seoTitle", label: "SEO title (optional)", max: 60, hint: "Defaults to the title." },
  { name: "seoDescription", label: "SEO description (optional)", type: "textarea", rows: 2, max: 160, hint: "Defaults to the excerpt." },
];

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

function NewPostCard({ canEdit }: { canEdit: boolean }) {
  const initial = { title: "", slug: "", status: "draft", excerpt: "", category: "Guides", readTime: "", body: "" };
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<any>(initial);
  const [slugTouched, setSlugTouched] = useState(false);
  const { busy, error, run, toast } = useWebsiteAction();
  if (!canEdit) return null;
  if (!open) return <div><button className="btn md" type="button" onClick={() => setOpen(true)}>+ New post</button></div>;
  return (
    <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card-title">New post</div>
      <Fields
        fields={POST_FIELDS}
        value={draft}
        disabled={busy}
        onChange={(next) => {
          if (next.slug !== draft.slug) setSlugTouched(true);
          if (!slugTouched && next.title !== draft.title) next = { ...next, slug: slugify(next.title) };
          setDraft(next);
        }}
      />
      {error && <div className="error-text">{error}</div>}
      <div className="toolbar">
        <button className="btn btn-primary md" type="button" disabled={busy} onClick={() => run({ action: "save", kind: "post", data: draft }, () => { setDraft(initial); setSlugTouched(false); setOpen(false); })}>
          Save draft
        </button>
        <button className="btn md" type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {toast}
    </div>
  );
}

export function PostsSection({ posts, canEdit, siteUrl }: { posts: EntryView<any>[]; canEdit: boolean; siteUrl: string }) {
  const [filter, setFilter] = useState<"all" | "published" | "coming_soon" | "draft">("all");
  const shown = useMemo(() => posts.filter((p) => filter === "all" || p.data?.status === filter), [posts, filter]);
  const statusChip = (s?: string) =>
    s === "published" ? <span className="chip sm chip-green">Published</span> : s === "coming_soon" ? <span className="chip sm chip-indigo">Coming soon</span> : <span className="chip sm chip-neutral">Hidden</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="toolbar">
        <div className="pills">
          {(["all", "published", "coming_soon", "draft"] as const).map((f) => (
            <button key={f} type="button" className={`pill${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "coming_soon" ? "Coming soon" : f === "draft" ? "Hidden" : "Published"}
            </button>
          ))}
        </div>
      </div>
      <NewPostCard canEdit={canEdit} />
      {shown.length === 0 && <div className="card empty"><strong>No posts here</strong></div>}
      {shown.map((p) => (
        <ItemCard
          key={p.key}
          kind="post"
          entry={p}
          title={p.data?.title ?? "Removed"}
          fields={POST_FIELDS}
          canEdit={canEdit}
          removable
          extra={(d) => (
            <div className="toolbar">
              {statusChip(d?.status)}
              {p.data?.publishedAt && <span className="hint">First published {new Date(p.data.publishedAt).toLocaleDateString("en-IN")}</span>}
              {!p.isNew && p.data?.status === "published" && !p.changed && (
                <a className="hint" href={`${siteUrl}/blog/${p.data.slug}`} target="_blank" rel="noreferrer">Open on site ↗</a>
              )}
            </div>
          )}
        />
      ))}
    </div>
  );
}

export function ImagesSection({ images, canEdit }: { images: { path: string; bytes: number; at: string }[]; canEdit: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files)) await uploadImage(f);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="toolbar">
        <div className="grow hint">
          Every image uploaded for the website. Use the address in a post, a page&apos;s share image or anywhere an image is asked for. Images go live with the next Publish.
        </div>
        {canEdit && (
          <button className="btn btn-primary md" type="button" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Uploading…" : "Upload images"}
          </button>
        )}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => upload(e.target.files)} />
      </div>
      {error && <div className="notice notice-error">{error}</div>}
      {images.length === 0 ? (
        <div className="card empty"><strong>No images yet</strong>Upload one here, or from any image field.</div>
      ) : (
        <div className="grid-4">
          {images.map((img) => (
            <div key={img.path} className="card" style={{ overflow: "hidden" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewSrc(img.path)} alt="" style={{ width: "100%", height: 120, objectFit: "cover", display: "block" }} />
              <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
                <code className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>{img.path}</code>
                <div className="toolbar">
                  <span className="hint grow">{Math.round(img.bytes / 1024)} KB</span>
                  <button
                    className="btn sm"
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(img.path).catch(() => {});
                      setCopied(img.path);
                      setTimeout(() => setCopied(null), 1500);
                    }}
                  >
                    {copied === img.path ? "Copied" : "Copy address"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
