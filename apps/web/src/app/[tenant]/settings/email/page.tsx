"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface EmailConnection {
  id: string;
  provider: string;
  address: string;
  status: string;
  paused?: boolean;
  folder?: string | null;
  imapHost?: string | null;
  imapPort?: number | null;
  defaultJobId?: string | null;
  autoRoute?: boolean;
  lastPollAt?: string | null;
  errorDetail?: string | null;
  hasCredential?: boolean;
  oauthUrl?: string | null;
}

interface Job {
  id: string;
  title: string;
  status?: string;
}

interface TestResult {
  ok: boolean;
  messages?: number;
  folders?: string[];
  error?: string;
  hint?: string | null;
  
}


// Share Tailwind fragments so every field/card across this page (and the
// nested ConnectionRow) stays visually identical.
const labelCls = "mb-1.5 block text-sm font-semibold text-[var(--text)]";
const hintCls = "mt-1.5 text-xs text-[var(--text-muted)]";
const inputCls =
  "w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--text)] outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent)]/15";
const cardCls = "rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)] sm:p-6";
const primaryBtn =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[var(--accent-hover)] px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-[var(--accent)]/25 transition hover:shadow-lg hover:shadow-[var(--accent)]/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none";
const secondaryBtn =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold text-[var(--text)] transition hover:border-[var(--accent-border)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";
const dangerBtn =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--danger-border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold text-[var(--danger)] transition hover:bg-[var(--danger-soft)]";

function MailIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="14" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="m4 7 8 6 8-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M5 12.5 9.5 17 19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon({ open, className = "h-4 w-4" }: { open: boolean; className?: string }) {
  return (
    <svg className={`${className} transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
    </svg>
  );
}

export default function EmailSettingsPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;

  const [connections, setConnections] = useState<EmailConnection[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // --- add form -----------------------------------------------------------
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [jobId, setJobId] = useState("");
  const [autoRoute, setAutoRoute] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(993);
  const [username, setUsername] = useState("");
  const [folder, setFolder] = useState("INBOX");
  const [hostTouched, setHostTouched] = useState(false);

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  const load = useCallback(() => {
    fetch(`/api/${tenant}/email-connections`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        setConnections(data.connections ?? []);
        setJobs(data.jobs ?? []);
      })
      .catch(() => setError("Failed to load email settings"));
  }, [tenant]);

  useEffect(load, [load]);

  // cPanel, Plesk and most hosts serve IMAP at mail.<domain>, so the server is
  // derived from the address and the user never has to know it.
  const guessedHost = useMemo(() => {
    const domain = address.split("@")[1];
    return domain ? `mail.${domain}` : "";
  }, [address]);

  const effectiveHost = hostTouched && host ? host : guessedHost;
  const ready = Boolean(address && password && jobId && effectiveHost);

  function payload() {
    return {
      address,
      imapHost: effectiveHost,
      imapPort: Number(port),
      imapSecure: Number(port) !== 143,
      imapUsername: username || address,
      imapPassword: password,
      folder,
    };
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/email-connections/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not test the mailbox");
      } else {
        setTest(data.result);
      }
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/email-connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "imap", ...payload(), defaultJobId: jobId, autoRoute }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not connect the mailbox");
        return;
      }
      setMessage(`Connected ${address}. New mail will be picked up automatically.`);
      setPassword("");
      setTest(null);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>, okMessage: string) {
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/email-connections/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Update failed");
      return;
    }
    setMessage(okMessage);
    load();
  }

  async function remove(conn: EmailConnection) {
    if (!window.confirm(`Disconnect ${conn.address}? Candidates already imported are kept.`)) return;
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/email-connections/${conn.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.message || "Could not disconnect the mailbox");
      return;
    }
    setMessage(`Disconnected ${conn.address}.`);
    load();
  }

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center gap-3">
        <div className="grid h-11 w-11 flex-none place-items-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white shadow-lg shadow-[var(--accent)]/25">
          <MailIcon />
        </div>
        <h1 className="!mb-0">Email settings</h1>
      </div>
      <p className="muted mb-6">
        Connect the mailbox that receives applications. Pratibha reads new mail, extracts the CV, and creates a
        candidate automatically. Nothing in your DNS changes — no MX records to edit.
      </p>

      {error && (
        <div className="mb-5 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
      {message && (
        <div className="mb-5 flex items-center gap-2 rounded-xl border border-[var(--success-border)] bg-[var(--success-soft)] px-4 py-3 text-sm text-[var(--success)]">
          <CheckIcon className="flex-none" />
          {message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-6">
          <div className={cardCls}>
            <h3 className="mb-5 text-base font-semibold text-[var(--text)]">Connect a mailbox</h3>

            <div className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2">
              <div>
                <label htmlFor="address" className={labelCls}>
                  Email address
                </label>
                <input
                  id="address"
                  type="email"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="you@yourcompany.com"
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor="password" className={labelCls}>
                  Mailbox password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder="the password you use for webmail"
                  className={inputCls}
                />
              </div>
            </div>

            <div className="mt-6">
              <label className={labelCls}>Which job do these applications belong to?</label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[
                  { auto: true, title: "All jobs", desc: "One mailbox for every open role. Each application is matched to a job from its subject line." },
                  { auto: false, title: "One job only", desc: "File everything from this mailbox into a single job." },
                ].map((opt) => {
                  const selected = autoRoute === opt.auto;
                  return (
                    <button
                      key={opt.title}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setAutoRoute(opt.auto)}
                      className={[
                          "!flex !w-full !min-w-0 !flex-col !items-stretch !justify-start gap-1 rounded-2xl border p-4 text-left transition",
                          selected
                              ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                              : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent-border)]",
                      ].join(" ")}
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <span
                          className={[
                            "grid h-4 w-4 flex-none place-items-center rounded-full border-2",
                            selected ? "border-[var(--accent)]" : "border-[var(--border-strong)]",
                          ].join(" ")}
                        >
                          {selected && <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />}
                        </span>
                        <span className="text-sm font-semibold text-[var(--text)]">{opt.title}</span>
                      </div>
                      <p className="min-w-0 whitespace-normal break-words text-xs leading-relaxed text-[var(--text-muted)]">
                          {opt.desc}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-6">
              <label htmlFor="job" className={labelCls}>
                {autoRoute ? "Fallback job (for mail that matches no role)" : "File candidates into"}
              </label>
              <select id="job" value={jobId} onChange={(e) => setJobId(e.target.value)} className={inputCls}>
                <option value="">Select a job…</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.title}
                  </option>
                ))}
              </select>
              {autoRoute && (
                <p className={hintCls}>
                  Applications that do not clearly name a role land here instead of being dropped, so nothing is lost.
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--accent)] hover:text-[var(--accent-hover)]"
            >
              {showAdvanced ? "Hide" : "Show"} advanced settings
              <ChevronIcon open={showAdvanced} />
            </button>

            {showAdvanced ? (
              <div className="mt-4 space-y-5 rounded-2xl border-l-[3px] border-[var(--accent-border)] bg-[var(--surface-2)] p-4">
                <div>
                  <label htmlFor="host" className={labelCls}>
                    IMAP server
                  </label>
                  <input
                    id="host"
                    value={effectiveHost}
                    onChange={(e) => {
                      setHostTouched(true);
                      setHost(e.target.value);
                    }}
                    className={inputCls}
                  />
                  <p className={hintCls}>Detected from your address. Change it only if your host is different.</p>
                </div>

                <div>
                  <label htmlFor="port" className={labelCls}>
                    Port
                  </label>
                  <select id="port" value={port} onChange={(e) => setPort(Number(e.target.value))} className={inputCls}>
                    <option value={993}>993 — SSL/TLS (recommended)</option>
                    <option value={143}>143 — STARTTLS</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="user" className={labelCls}>
                    Username
                  </label>
                  <input
                    id="user"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={address || "defaults to the full email address"}
                    className={inputCls}
                  />
                </div>

                <div>
                  <label htmlFor="folder" className={labelCls}>
                    Folder
                  </label>
                  <input id="folder" value={folder} onChange={(e) => setFolder(e.target.value)} className={inputCls} />
                </div>
              </div>
            ) : (
              <p className={hintCls}>
                Server, port and folder are detected automatically{effectiveHost ? ` (${effectiveHost}:${port})` : ""}.
              </p>
            )}

            <div className="mt-6 flex flex-wrap gap-3 border-t border-[var(--border)] pt-5">
              <button onClick={runTest} disabled={testing || !address || !password} className={secondaryBtn}>
                {testing && <Spinner />}
                {testing ? "Testing…" : "Test connection"}
              </button>
              <button onClick={save} disabled={saving || !ready} className={primaryBtn}>
                {saving && <Spinner />}
                {saving ? "Connecting…" : "Connect mailbox"}
              </button>
            </div>

            {test && (
              <div
                className={[
                  "mt-4 rounded-2xl border p-4",
                  test.ok
                    ? "border-[var(--success-border)] bg-[var(--success-soft)]"
                    : "border-[var(--danger-border)] bg-[var(--danger-soft)]",
                ].join(" ")}
              >
                {test.ok ? (
                  <>
                    <div className="flex items-center gap-2 font-semibold text-[var(--success)]">
                      <CheckIcon />
                      Signed in successfully.
                    </div>
                    <div className="mt-1.5 text-sm text-[var(--success)]">
                      {test.messages} message(s) in {folder}.
                    </div>
                    {test.folders && test.folders.length > 0 && (
                      <div className="mt-2 text-xs text-[var(--text-muted)]">
                        Folders: {test.folders.slice(0, 12).join(", ")}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <strong className="text-[var(--danger)]">Could not sign in.</strong>
                    <div className="mt-1.5 text-sm text-[var(--danger)]">{test.error}</div>
                    {test.hint && <div className="mt-2 text-sm text-[var(--text)]">{test.hint}</div>}
                  </>
                )}
              </div>
            )}

            <p className={`${hintCls} mt-5`}>
              The password is encrypted before it is stored and is never shown again. On first connect, mail from the
              last 7 days is imported.
            </p>
          </div>

          <div>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-[var(--text)]">Connected mailboxes</h3>
              {connections.length > 0 && (
                <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--text-muted)]">
                  {connections.length}
                </span>
              )}
            </div>
            {connections.length === 0 ? (
              <div className="flex flex-col items-center rounded-3xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] py-12 text-center">
                <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white">
                  <MailIcon className="h-5 w-5" />
                </div>
                <p className="text-sm text-[var(--text-muted)]">Nothing connected yet.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {connections.map((conn) => (
                  <ConnectionRow key={conn.id} conn={conn} jobs={jobs} onPatch={patch} onRemove={remove} />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-6 xl:sticky xl:top-6 xl:self-start">
          <div className={cardCls}>
            <h3 className="mb-2 text-base font-semibold text-[var(--text)]">Forwarding instead</h3>
            <p className="mb-3 text-sm text-[var(--text-muted)]">
              Prefer not to share a password? Set a forwarding rule in your mail host and send applications to:
            </p>
            <code className="block break-all rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm text-[var(--text)]">
              {tenant}@in.pratibha.tech
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectionRow({
  conn,
  jobs,
  onPatch,
  onRemove,
}: {
  conn: EmailConnection;
  jobs: Job[];
  onPatch: (id: string, body: Record<string, unknown>, okMessage: string) => Promise<void>;
  onRemove: (conn: EmailConnection) => Promise<void>;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [open, setOpen] = useState(false);

  const paused = conn.paused ?? conn.status === "revoked";
  const badge = paused
    ? { text: "Paused", cls: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]" }
    : conn.status === "error"
      ? { text: "Error", cls: "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]" }
      : { text: "Active", cls: "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]" };
  const dotCls = paused ? "bg-[var(--text-subtle)]" : conn.status === "error" ? "bg-[var(--danger)]" : "bg-[var(--success)]";

  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-sm font-bold text-white">
            {conn.address.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="truncate text-sm text-[var(--text)]">{conn.address}</strong>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badge.cls}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${dotCls}`} />
                {badge.text}
              </span>
            </div>
            <div className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
              {conn.imapHost}:{conn.imapPort} · {conn.folder} · {conn.autoRoute ? "all jobs" : "one job"}
              {conn.lastPollAt && ` · last checked ${new Date(conn.lastPollAt).toLocaleString()}`}
            </div>
            {conn.errorDetail && <div className="mt-0.5 text-xs text-[var(--danger)]">{conn.errorDetail}</div>}
          </div>
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} className={`${secondaryBtn} flex-none py-2`}>
          {open ? "Close" : "Manage"}
          <ChevronIcon open={open} className="h-3.5 w-3.5" />
        </button>
      </div>

      {open && (
        <div className="mt-5 border-t border-[var(--border)] pt-5">
          <div className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2">
            <div>
              <label htmlFor={`route-${conn.id}`} className={labelCls}>
                Routing
              </label>
              <select
                id={`route-${conn.id}`}
                defaultValue={conn.autoRoute ? "auto" : "fixed"}
                onChange={(e) =>
                  onPatch(
                    conn.id,
                    { autoRoute: e.target.value === "auto" },
                    e.target.value === "auto"
                      ? "Now matching applications to all open jobs."
                      : "Now filing everything into one job."
                  )
                }
                className={inputCls}
              >
                <option value="auto">All jobs — match each application to a role</option>
                <option value="fixed">One job only</option>
              </select>
            </div>

            <div>
              <label htmlFor={`job-${conn.id}`} className={labelCls}>
                {conn.autoRoute ? "Fallback job" : "File candidates into"}
              </label>
              <select
                id={`job-${conn.id}`}
                defaultValue={conn.defaultJobId ?? ""}
                onChange={(e) => onPatch(conn.id, { defaultJobId: e.target.value }, "Destination job updated.")}
                className={inputCls}
              >
                <option value="">Select a job…</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-5">
            <label htmlFor={`pw-${conn.id}`} className={labelCls}>
              Change password
            </label>
            <input
              id={`pw-${conn.id}`}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="enter a new mailbox password"
              className={inputCls}
            />
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              onClick={async () => {
                await onPatch(conn.id, { imapPassword: newPassword }, "Password updated and verified.");
                setNewPassword("");
              }}
              disabled={!newPassword}
              className={primaryBtn}
            >
              Save password
            </button>

            <button
              onClick={() =>
                onPatch(
                  conn.id,
                  { status: paused ? "connected" : "revoked" },
                  paused ? "Mailbox resumed." : "Mailbox paused — no new mail will be read."
                )
              }
              className={secondaryBtn}
            >
              {paused ? "Resume" : "Pause"}
            </button>

            <button onClick={() => onRemove(conn)} className={dangerBtn}>
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}