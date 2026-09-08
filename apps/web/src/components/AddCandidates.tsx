"use client";

import { useCallback, useRef, useState } from "react";
// Subpath import, not the package barrel: this is a client component and the
// barrel would bring zod into the browser bundle.
import { MAX_CV_UPLOAD_FILES, planCvUploadBatches } from "@pratibha/shared/limits";

/**
 * Adding candidates to a job without waiting for the mailbox.
 *
 * The same panel does one CV and a hundred: a bulk import is just a
 * multi-select on the same input, so there is no "bulk mode" for a recruiter to
 * find. Results come back per file, because in a batch of a hundred some will
 * be scans with no text layer and the recruiter needs to know which ones to
 * chase rather than being told "78 of 100 succeeded".
 */

interface IngestResult {
  filename: string;
  status: "created" | "merged" | "failed";
  candidateId?: string;
  name?: string | null;
  email?: string | null;
  phoneE164?: string | null;
  parseFailed?: boolean;
  reason?: string | null;
  needsOcr?: boolean;
  error?: string;
}

interface Summary {
  total: number;
  created: number;
  merged: number;
  failed: number;
  unparsed: number;
}

const ACCEPT = ".pdf,.txt,.md,.csv,.rtf";

export default function AddCandidates({
  tenant,
  jobId,
  onAdded,
}: {
  tenant: string;
  jobId: string;
  onAdded: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"upload" | "manual">("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<IngestResult[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [manual, setManual] = useState({ name: "", email: "", phone: "", notes: "" });
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming?.length) return;
    setError(null);
    setFiles((current) => {
      // Same file dragged in twice is the user being unsure it registered, not
      // a request to upload it twice.
      const seen = new Set(current.map((f) => `${f.name}:${f.size}`));
      const next = [...current];
      for (const file of Array.from(incoming)) {
        const key = `${file.name}:${file.size}`;
        if (!seen.has(key)) {
          seen.add(key);
          next.push(file);
        }
      }
      if (next.length > MAX_CV_UPLOAD_FILES) {
        setError(
          `Up to ${MAX_CV_UPLOAD_FILES} CVs at a time. Keeping the first ${MAX_CV_UPLOAD_FILES}.`
        );
        return next.slice(0, MAX_CV_UPLOAD_FILES);
      }
      return next;
    });
  }, []);

  function reset() {
    setFiles([]);
    setResults(null);
    setSummary(null);
    setProgress(null);
    setError(null);
    setManual({ name: "", email: "", phone: "", notes: "" });
    if (inputRef.current) inputRef.current.value = "";
  }

  /**
   * Send the selection in batches rather than as one request.
   *
   * A hundred CVs is roughly 30MB of multipart body, which nginx rejects at its
   * default 1MB `client_max_body_size` and most hosts cap well below 30MB — so
   * the single-request version works locally and fails in deployment. Batches
   * are bounded by size as well as count, because twenty scans are two orders
   * of magnitude larger than twenty ordinary CVs. Batching also gives the
   * recruiter a counter that moves, instead of one spinner sitting still for
   * minutes with no way to tell it apart from a hang.
   *
   * Results accumulate across batches so a failure partway through still shows
   * everything that landed before it.
   */
  async function uploadFiles() {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setResults(null);
    setSummary(null);

    const queued = files;
    const collected: IngestResult[] = [];
    setProgress({ done: 0, total: queued.length });

    try {
      let sent = 0;
      for (const batch of planCvUploadBatches(queued)) {
        const body = new FormData();
        body.append("jobId", jobId);
        for (const file of batch) body.append("files", file);

        const res = await fetch(`/api/${tenant}/candidates`, { method: "POST", body });
        const data = await res.json().catch(() => ({}));

        // A 422 still carries per-file results — every file in that batch
        // failed, and saying which is more useful than the status line.
        if (!res.ok && !Array.isArray(data.results)) {
          throw new Error(data.message || "Upload failed");
        }

        collected.push(...(data.results ?? []));
        sent += batch.length;
        setProgress({ done: sent, total: queued.length });
        // Show each batch as it lands rather than making the user wait for all
        // of them; on a long import this is the only sign work is happening.
        setResults([...collected]);
        setSummary(summarize(collected));
      }

      setFiles([]);
      if (inputRef.current) inputRef.current.value = "";
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : "Upload failed"}` +
          (collected.length ? ` ${collected.length} CV(s) were added before this.` : "")
      );
      // Whatever failed, the files that already landed must not be re-sent by a
      // retry, or the recruiter gets a second pass of merge results.
      setFiles(queued.slice(collected.length));
    } finally {
      setProgress(null);
      setBusy(false);
      // Reload once at the end: refreshing per batch would re-render the whole
      // candidate table several times during a large import.
      await onAdded();
    }
  }

  async function submitManual(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResults(null);

    try {
      const payload = {
        jobId,
        name: manual.name.trim() || undefined,
        email: manual.email.trim() || undefined,
        phone: manual.phone.trim() || undefined,
        notes: manual.notes.trim() || undefined,
      };

      const res = await fetch(`/api/${tenant}/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not add this candidate");

      setResults(data.results ?? []);
      setSummary(data.summary ?? null);
      setManual({ name: "", email: "", phone: "", notes: "" });
      await onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add this candidate");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="primary" onClick={() => setOpen(true)}>
        Add candidates
      </button>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ marginBottom: 14 }}>
        <strong>Add candidates</strong>
        <div className="row" style={{ gap: 6, marginLeft: 12 }}>
          <button
            className={`sm${mode === "upload" ? " primary" : ""}`}
            onClick={() => { setMode("upload"); setResults(null); }}
            disabled={busy}
          >
            Upload CVs
          </button>
          <button
            className={`sm${mode === "manual" ? " primary" : ""}`}
            onClick={() => { setMode("manual"); setResults(null); }}
            disabled={busy}
          >
            Type in details
          </button>
        </div>
        <button
          className="ghost sm"
          style={{ marginLeft: "auto" }}
          onClick={() => { setOpen(false); reset(); }}
          disabled={busy}
        >
          Close
        </button>
      </div>

      {error && <div className="notice notice-error" style={{ marginBottom: 14 }}>{error}</div>}

      {mode === "upload" ? (
        <>
          <div
            className={`dropzone${dragging ? " dropzone-active" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
          >
            <strong>Drop CVs here, or click to choose</strong>
            <span className="subtle">
              PDF or plain text, up to {MAX_CV_UPLOAD_FILES} CVs at a time, 15MB each.
              Select a whole folder for a bulk import.
            </span>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            style={{ display: "none" }}
            onChange={(e) => addFiles(e.target.files)}
          />

          {files.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="subtle">{files.length} file(s) ready</span>
                <button className="ghost sm" onClick={() => setFiles([])} disabled={busy}>
                  Clear
                </button>
              </div>
              <ul className="file-list">
                {files.map((file) => (
                  <li key={`${file.name}:${file.size}`}>
                    <span>{file.name}</span>
                    <span className="subtle">{formatBytes(file.size)}</span>
                    <button
                      className="ghost sm"
                      disabled={busy}
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setFiles((current) =>
                          current.filter((f) => !(f.name === file.name && f.size === file.size))
                        )
                      }
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="row" style={{ marginTop: 14 }}>
            <button className="primary" onClick={uploadFiles} disabled={busy || files.length === 0}>
              {progress
                ? `Importing ${progress.done} of ${progress.total}…`
                : busy
                  ? "Importing…"
                  : files.length > 1
                    ? `Import ${files.length} CVs`
                    : "Add candidate"}
            </button>
            {progress && (
              <span className="subtle" role="status" aria-live="polite">
                {progress.done} of {progress.total} read. Large PDFs take a moment each.
              </span>
            )}
          </div>
        </>
      ) : (
        <form onSubmit={submitManual} className="stack">
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <div>
              <label htmlFor="cand-name">Name</label>
              <input
                id="cand-name"
                type="text"
                value={manual.name}
                onChange={(e) => setManual({ ...manual, name: e.target.value })}
                placeholder="Priya Sharma"
              />
            </div>
            <div>
              <label htmlFor="cand-email">Email</label>
              <input
                id="cand-email"
                type="email"
                value={manual.email}
                onChange={(e) => setManual({ ...manual, email: e.target.value })}
                placeholder="priya@example.com"
              />
            </div>
            <div>
              <label htmlFor="cand-phone">Phone</label>
              <input
                id="cand-phone"
                type="text"
                value={manual.phone}
                onChange={(e) => setManual({ ...manual, phone: e.target.value })}
                placeholder="+91 98765 43210"
              />
            </div>
          </div>
          <div>
            <label htmlFor="cand-notes">CV text or notes</label>
            <textarea
              id="cand-notes"
              rows={5}
              value={manual.notes}
              onChange={(e) => setManual({ ...manual, notes: e.target.value })}
              placeholder="Paste the CV text here. Screening scores this against the job's must-haves, so the more you paste the better the score."
            />
          </div>
          <div className="row">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add candidate"}
            </button>
            <span className="subtle">
              A phone number is what makes this candidate callable for an interview.
            </span>
          </div>
        </form>
      )}

      {results && results.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {summary && (
            <div
              className={`notice ${summary.failed > 0 ? "notice-error" : "notice-success"}`}
              style={{ marginBottom: 10 }}
            >
              {describe(summary)}
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ paddingTop: 12 }}>File</th>
                  <th>Result</th>
                  <th>Parsed as</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result, i) => (
                  <tr key={`${result.filename}-${i}`}>
                    <td>{result.filename}</td>
                    <td>
                      <span className={`badge ${resultClass(result)}`}>{resultLabel(result)}</span>
                    </td>
                    <td className="subtle">
                      {result.status === "failed"
                        ? result.error
                        : result.parseFailed
                          ? result.reason ??
                            (result.needsOcr
                              ? "Scanned CV with no text layer — add the details by hand"
                              : "No name, email or phone found")
                          : [result.name, result.email, result.phoneE164]
                              .filter(Boolean)
                              .join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function resultLabel(result: IngestResult): string {
  if (result.status === "failed") return "could not read";
  if (result.parseFailed) return "added, unparsed";
  return result.status === "merged" ? "merged into existing" : "added";
}

function resultClass(result: IngestResult): string {
  if (result.status === "failed") return "badge-danger";
  if (result.parseFailed) return "badge-warning";
  if (result.status === "merged") return "badge-accent";
  return "badge-success";
}

/**
 * Recomputed here rather than merging the per-batch summaries the server sends,
 * so the counts stay right while an import is still running.
 */
function summarize(results: IngestResult[]): Summary {
  return {
    total: results.length,
    created: results.filter((r) => r.status === "created").length,
    merged: results.filter((r) => r.status === "merged").length,
    failed: results.filter((r) => r.status === "failed").length,
    unparsed: results.filter((r) => r.status !== "failed" && r.parseFailed).length,
  };
}

function describe(summary: Summary): string {
  const parts: string[] = [];
  if (summary.created) parts.push(`${summary.created} added`);
  if (summary.merged) parts.push(`${summary.merged} merged into existing candidates`);
  if (summary.unparsed) parts.push(`${summary.unparsed} need details filled in by hand`);
  if (summary.failed) parts.push(`${summary.failed} could not be read`);
  return parts.length ? `${parts.join(", ")}.` : "Nothing to add.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
