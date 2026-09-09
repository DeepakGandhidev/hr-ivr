"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/**
 * Everything about one candidate, on one screen.
 *
 * The brief was that a hiring manager should be able to answer "who is this,
 * what did we learn, what happened so far" without opening anything else, so
 * each section is present even when empty — an absent "Call history" heading
 * reads as a page that failed to load, where "No calls yet" is an answer.
 */

interface Author { id: string; name: string | null; email: string }

interface Note {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  authorId: string;
  author: Author;
}

interface Screening {
  id: string;
  score: number;
  verdict: string;
  reasonSummary: string;
  matchedMustHaves: string[];
  gaps: string[];
  failed: boolean;
  createdAt: string;
}

interface Report {
  overallScore: number;
  recommendation: string;
  dimensions: Record<string, number> | Array<{ name: string; score: number }>;
  strengths: string[];
  concerns: string[];
  notableQuotes: unknown;
  generatedAt: string;
}

interface Call {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: string | null;
  language: string | null;
  transcriptRef: string | null;
  recordingRef: string | null;
  assessmentReport: Report | null;
}

interface Candidate {
  id: string;
  name: string | null;
  email: string | null;
  phoneE164: string | null;
  cvFileRef: string | null;
  cvParsed: { rawPreview?: string; experience?: string; skills?: string[] } | null;
  parseFailed: boolean;
  createdAt: string;
  job: { id: string; title: string };
  screenings: Screening[];
  notes: Note[];
  interviewCalls: Call[];
  shortlistItems: Array<{
    createdAt: string;
    shortlist: { id: string; status: string; approvals: Array<{ approvedAt: string }> };
  }>;
}

interface TimelineEvent { at: string; kind: string; title: string; detail: string }

const LANGUAGES: Record<string, string> = { en: "English", hi: "Hindi", hinglish: "Hinglish" };

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function duration(start: string, end: string | null) {
  if (!end) return "in progress";
  const secs = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

/** The stage the candidate has actually reached, derived from the rows. */
function stageOf(c: Candidate) {
  if (c.interviewCalls.some((call) => call.assessmentReport)) return "Assessed";
  if (c.interviewCalls.length) return "Interviewed";
  if (c.shortlistItems.some((i) => i.shortlist.approvals.length)) return "Approved";
  if (c.shortlistItems.length) return "Shortlisted";
  if (c.screenings.length) return "Screened";
  return "Applied";
}

export default function CandidatePage({ params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/${tenant}/candidates/${id}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Could not load this candidate");
      return;
    }
    setCandidate(data.candidate);
    setTimeline(data.timeline ?? []);
  }, [tenant, id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMe(d?.user?.id ?? null))
      .catch(() => {});
  }, []);

  if (error) return <div className="notice notice-error">{error}</div>;
  if (!candidate) return <div className="card empty"><p className="muted">Loading…</p></div>;

  const latest = candidate.screenings[0];
  const report = candidate.interviewCalls.find((c) => c.assessmentReport)?.assessmentReport ?? null;

  return (
    <div className="dash" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <Link href={`/${tenant}/pipeline`} className="subtle">&larr; Pipeline</Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0 }}>{candidate.name ?? candidate.email ?? "Unnamed candidate"}</h1>
          <span className="pill gate">{stageOf(candidate)}</span>
          {latest && <span className={`score${latest.score >= 75 ? " hi" : ""}`}>{latest.score}</span>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          <div>
            <div className="subtle">Applied for</div>
            <Link href={`/${tenant}/jobs/${candidate.job.id}`} style={{ fontWeight: 550 }}>
              {candidate.job.title}
            </Link>
          </div>
          <div>
            <div className="subtle">Phone</div>
            <div style={{ fontWeight: 550 }}>
              {candidate.phoneE164 ?? <span className="pill bad">No phone</span>}
            </div>
          </div>
          <div>
            <div className="subtle">Email</div>
            <div style={{ fontWeight: 550 }}>{candidate.email ?? "—"}</div>
          </div>
          <div>
            <div className="subtle">CV</div>
            {/* #4 is not built yet, so this states the position rather than
                offering a control that would do nothing. */}
            <div style={{ fontWeight: 550 }}>
              {candidate.parseFailed
                ? <span className="pill mute">Unreadable</span>
                : candidate.cvParsed
                  ? <span className="pill ok">Text on file</span>
                  : <span className="pill mute">None</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Screening {candidate.screenings.length > 1 ? `(${candidate.screenings.length})` : ""}</h2>
        {candidate.screenings.length === 0 ? (
          <p className="muted">Not screened yet.</p>
        ) : (
          <div className="stack" style={{ gap: 16 }}>
            {candidate.screenings.map((s) => (
              <div key={s.id} style={{ borderTop: "1px solid var(--line-2)", paddingTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <span className={`score${s.score >= 75 ? " hi" : ""}`} style={{ fontSize: 20 }}>{s.score}</span>
                    <span className={`pill ${s.verdict === "shortlist" ? "ok" : "mute"}`} style={{ marginLeft: 8 }}>
                      {s.verdict}
                    </span>
                  </div>
                  <span className="subtle">{new Date(s.createdAt).toLocaleString()}</span>
                </div>
                <p style={{ marginTop: 8 }}>{s.reasonSummary}</p>
                <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginTop: 10 }}>
                  <div>
                    <div className="subtle" style={{ marginBottom: 6 }}>Matched</div>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      {asArray(s.matchedMustHaves).map((m) => <span key={m} className="pill ok">{m}</span>)}
                      {asArray(s.matchedMustHaves).length === 0 && <span className="subtle">None recorded</span>}
                    </div>
                  </div>
                  <div>
                    <div className="subtle" style={{ marginBottom: 6 }}>Gaps</div>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      {asArray(s.gaps).map((g) => <span key={g} className="pill bad">{g}</span>)}
                      {asArray(s.gaps).length === 0 && <span className="subtle">None recorded</span>}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Call history</h2>
        {candidate.interviewCalls.length === 0 ? (
          <p className="muted">This candidate has not called yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>Duration</th><th>Language</th><th>Outcome</th><th>Transcript</th></tr>
              </thead>
              <tbody>
                {candidate.interviewCalls.map((call) => (
                  <tr key={call.id}>
                    <td>{new Date(call.startedAt).toLocaleString()}</td>
                    <td>{duration(call.startedAt, call.endedAt)}</td>
                    <td>{call.language ? LANGUAGES[call.language] ?? call.language : "—"}</td>
                    <td>
                      <span className={`pill ${call.status === "completed" ? "ok" : call.status ? "bad" : "mute"}`}>
                        {call.status ? call.status.replace(/_/g, " ") : "in progress"}
                      </span>
                    </td>
                    <td>
                      {/* transcriptRef is never populated today — transcripts
                          live in ProMonkey OS, whose client is write-only. Rather
                          than a dead link, this says so. */}
                      {call.transcriptRef
                        ? <a href={call.transcriptRef}>Open</a>
                        : <span className="subtle">In ProMonkey OS</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {report && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="sec-h">
            <h2 style={{ margin: 0 }}>Interview report</h2>
            <span className="subtle">{new Date(report.generatedAt).toLocaleString()}</span>
          </div>
          <div className="row" style={{ gap: 14, alignItems: "baseline" }}>
            <span className="score hi" style={{ fontSize: 30 }}>{report.overallScore}</span>
            <span className="pill gate">{report.recommendation.replace(/_/g, " ")}</span>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginTop: 14 }}>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Strengths</div>
              <ul style={{ paddingLeft: 18 }}>
                {asArray(report.strengths).map((s) => <li key={s}>{s}</li>)}
              </ul>
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Concerns</div>
              <ul style={{ paddingLeft: 18 }}>
                {asArray(report.concerns).map((c) => <li key={c}>{c}</li>)}
              </ul>
            </div>
          </div>

          <Dimensions dimensions={report.dimensions} />
          <Quotes quotes={report.notableQuotes} />
        </div>
      )}

      <Notes tenant={tenant} candidateId={id} notes={candidate.notes} meId={me} onChanged={load} />

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Timeline</h2>
        <div className="feed">
          {timeline.map((e, i) => (
            <div className="ev" key={`${e.at}-${i}`}>
              <time>{new Date(e.at).toLocaleDateString()}</time>
              <div><b>{e.title}</b> <span>· {e.detail}</span></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Dimension scores arrive as either a map or a list, depending on the model run. */
function Dimensions({ dimensions }: { dimensions: Report["dimensions"] }) {
  const rows: Array<[string, number]> = Array.isArray(dimensions)
    ? dimensions.map((d) => [d.name, d.score])
    : Object.entries(dimensions ?? {}).filter(([, v]) => typeof v === "number") as Array<[string, number]>;

  if (rows.length === 0) return null;

  return (
    <div style={{ marginTop: 14 }}>
      <div className="subtle" style={{ marginBottom: 6 }}>Dimensions</div>
      {rows.map(([name, score]) => (
        <div key={name} className="usage-meter">
          {name}
          <span className="val">{score}</span>
          <div className="track"><div className="fill" style={{ width: `${Math.min(100, score * 10)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function Quotes({ quotes }: { quotes: unknown }) {
  const list = Array.isArray(quotes) ? quotes : [];
  if (list.length === 0) return null;

  return (
    <div style={{ marginTop: 14 }}>
      <div className="subtle" style={{ marginBottom: 6 }}>Notable quotes</div>
      {list.map((q, i) => {
        const text = typeof q === "string" ? q : (q as { quote?: string })?.quote ?? JSON.stringify(q);
        return (
          <blockquote
            key={i}
            style={{ borderLeft: "3px solid var(--saffron)", paddingLeft: 12, margin: "8px 0", color: "var(--brand-muted)" }}
          >
            {text}
          </blockquote>
        );
      })}
    </div>
  );
}

/**
 * Notes, newest first. Edit and delete appear only on your own — and the API
 * enforces that too, so hiding the buttons is a courtesy, not the control.
 */
function Notes({
  tenant, candidateId, notes, meId, onChanged,
}: {
  tenant: string;
  candidateId: string;
  notes: Note[];
  meId: string | null;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message || "That did not save");
        return false;
      }
      onChanged();
      return true;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Notes</h2>

      <div className="stack" style={{ gap: 8, marginBottom: 16 }}>
        <textarea
          rows={3}
          value={draft}
          placeholder="Add a note for the team…"
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !draft.trim()}
            onClick={async () => {
              if (await send(`/api/${tenant}/candidates/${candidateId}/notes`, "POST", { body: draft })) {
                setDraft("");
              }
            }}
          >
            Add note
          </button>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      {notes.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {notes.map((note) => (
            <div key={note.id} style={{ borderTop: "1px solid var(--line-2)", paddingTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <strong>{note.author.name ?? note.author.email}</strong>
                <span className="subtle">
                  {new Date(note.createdAt).toLocaleString()}
                  {note.updatedAt !== note.createdAt && " · edited"}
                </span>
              </div>

              {editing === note.id ? (
                <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                  <textarea rows={3} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy || !editBody.trim()}
                      onClick={async () => {
                        if (await send(`/api/${tenant}/candidates/${candidateId}/notes/${note.id}`, "PATCH", { body: editBody })) {
                          setEditing(null);
                        }
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{note.body}</p>
                  {meId === note.authorId && (
                    <div className="row" style={{ gap: 8, marginTop: 6 }}>
                      <button
                        type="button"
                        className="rowbtn"
                        onClick={() => { setEditing(note.id); setEditBody(note.body); }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="rowbtn"
                        disabled={busy}
                        onClick={() => send(`/api/${tenant}/candidates/${candidateId}/notes/${note.id}`, "DELETE")}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
