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
    <div style={{ maxWidth: 720 }}>
      <div className="page-head">
        <h1>Email settings</h1>
        <p className="muted">
        Connect the mailbox that receives applications. Pratibha reads new mail,
        extracts the CV, and creates a candidate automatically. Nothing in your
          DNS changes — no MX records to edit.
        </p>
      </div>

      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}

      <div className="card">
        <h3>Connect a mailbox</h3>

        <label htmlFor="address">Email address</label>
        <input
          id="address"
          type="email"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="you@yourcompany.com"
          
        />

        <label htmlFor="password">Mailbox password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder="the password you use for webmail"
          
        />

        <label >Which job do these applications belong to?</label>
        <div style={{ marginTop: 6, marginBottom: 12 }}>
          <label style={{ display: "block", fontWeight: 400, marginBottom: 6 }}>
            <input
              type="radio"
              name="routing"
              checked={autoRoute}
              onChange={() => setAutoRoute(true)}
              style={{ marginRight: 8 }}
            />
            <strong>All jobs</strong> — one mailbox for every open role. Each
            application is matched to a job from its subject line.
          </label>
          <label style={{ display: "block", fontWeight: 400 }}>
            <input
              type="radio"
              name="routing"
              checked={!autoRoute}
              onChange={() => setAutoRoute(false)}
              style={{ marginRight: 8 }}
            />
            <strong>One job only</strong> — file everything from this mailbox
            into a single job.
          </label>
        </div>

        <label htmlFor="job">
          {autoRoute ? "Fallback job (for mail that matches no role)" : "File candidates into"}
        </label>
        <select id="job" value={jobId} onChange={(e) => setJobId(e.target.value)} >
          <option value="">Select a job…</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>{j.title}</option>
          ))}
        </select>
        {autoRoute && (
          <p className="subtle">
            Applications that do not clearly name a role land here instead of
            being dropped, so nothing is lost.
          </p>
        )}

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="sm ghost" style={{ marginBottom: 14 }}
        >
          {showAdvanced ? "Hide" : "Show"} advanced settings
        </button>

        {showAdvanced ? (
          <div style={{ borderLeft: "3px solid #e5e7eb", paddingLeft: 14 }}>
            <label htmlFor="host">IMAP server</label>
            <input
              id="host"
              value={effectiveHost}
              onChange={(e) => { setHostTouched(true); setHost(e.target.value); }}
              
            />
            <p className="subtle">Detected from your address. Change it only if your host is different.</p>

            <label htmlFor="port">Port</label>
            <select id="port" value={port} onChange={(e) => setPort(Number(e.target.value))} >
              <option value={993}>993 — SSL/TLS (recommended)</option>
              <option value={143}>143 — STARTTLS</option>
            </select>

            <label htmlFor="user">Username</label>
            <input
              id="user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={address || "defaults to the full email address"}
              
            />

            <label htmlFor="folder">Folder</label>
            <input id="folder" value={folder} onChange={(e) => setFolder(e.target.value)}  />
          </div>
        ) : (
          <p className="subtle">
            Server, port and folder are detected automatically
            {effectiveHost ? ` (${effectiveHost}:${port})` : ""}.
          </p>
        )}

        <div className="row">
          <button onClick={runTest} disabled={testing || !address || !password} >
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button onClick={save} disabled={saving || !ready} className="primary">
            {saving ? "Connecting…" : "Connect mailbox"}
          </button>
        </div>

        {test && (
          <div
            style={{
              marginTop: 14,
              padding: 12,
              borderRadius: 6,
              background: test.ok ? "#f0fdf4" : "#fef2f2",
              border: `1px solid ${test.ok ? "#bbf7d0" : "#fecaca"}`,
            }}
          >
            {test.ok ? (
              <>
                <strong>Signed in successfully.</strong>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  {test.messages} message(s) in {folder}.
                </div>
                {test.folders && test.folders.length > 0 && (
                  <div className="subtle" style={{ marginTop: 6 }}>
                    Folders: {test.folders.slice(0, 12).join(", ")}
                  </div>
                )}
              </>
            ) : (
              <>
                <strong>Could not sign in.</strong>
                <div style={{ fontSize: 13, marginTop: 4 }}>{test.error}</div>
                {test.hint && <div style={{ marginTop: 6 }}>{test.hint}</div>}
              </>
            )}
          </div>
        )}

        <p className="subtle" style={{ marginTop: 14 }}>
          The password is encrypted before it is stored and is never shown again.
          On first connect, mail from the last 7 days is imported.
        </p>
      </div>

      <h3>Connected mailboxes</h3>
      {connections.length === 0 ? (
        <p style={{ color: "var(--text-muted)" }}>Nothing connected yet.</p>
      ) : (
        connections.map((conn) => (
          <ConnectionRow
            key={conn.id}
            conn={conn}
            jobs={jobs}
            onPatch={patch}
            onRemove={remove}
          />
        ))
      )}

      <div className="card">
        <h3>Forwarding instead</h3>
        <p style={{ marginBottom: 8 }}>
          Prefer not to share a password? Set a forwarding rule in your mail host
          and send applications to:
        </p>
        <code >
          {tenant}@in.pratibha.tech
        </code>
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
    ? { text: "Paused", cls: "badge-neutral" }
    : conn.status === "error"
      ? { text: "Error", cls: "badge-danger" }
      : { text: "Active", cls: "badge-success" };

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <strong>{conn.address}</strong>
          <span className={`badge ${badge.cls}`} style={{ marginLeft: 10 }}>{badge.text}</span>
          <div className="subtle" style={{ marginTop: 4 }}>
            {conn.imapHost}:{conn.imapPort} · {conn.folder} · {conn.autoRoute ? "all jobs" : "one job"}
            {conn.lastPollAt && ` · last checked ${new Date(conn.lastPollAt).toLocaleString()}`}
          </div>
          {conn.errorDetail && (
            <div className="subtle" style={{ color: "var(--danger)", marginTop: 4 }}>{conn.errorDetail}</div>
          )}
        </div>
        <button onClick={() => setOpen((v) => !v)} style={{ whiteSpace: "nowrap" }}>
          {open ? "Close" : "Manage"}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
          <label htmlFor={`route-${conn.id}`}>Routing</label>
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
            
          >
            <option value="auto">All jobs — match each application to a role</option>
            <option value="fixed">One job only</option>
          </select>

          <label htmlFor={`job-${conn.id}`}>
            {conn.autoRoute ? "Fallback job" : "File candidates into"}
          </label>
          <select
            id={`job-${conn.id}`}
            defaultValue={conn.defaultJobId ?? ""}
            onChange={(e) => onPatch(conn.id, { defaultJobId: e.target.value }, "Destination job updated.")}
            
          >
            <option value="">Select a job…</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>{j.title}</option>
            ))}
          </select>

          <label htmlFor={`pw-${conn.id}`}>Change password</label>
          <input
            id={`pw-${conn.id}`}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="enter a new mailbox password"
            
          />

          <div className="row">
            <button
              onClick={async () => {
                await onPatch(conn.id, { imapPassword: newPassword }, "Password updated and verified.");
                setNewPassword("");
              }}
              disabled={!newPassword}
              className="primary"
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
              
            >
              {paused ? "Resume" : "Pause"}
            </button>

            <button onClick={() => onRemove(conn)} className="danger">
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
