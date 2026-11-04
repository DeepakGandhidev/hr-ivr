"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Time from "@/components/Time";
import { useCopy } from "@/lib/copy-client";

type Provider = "gmail" | "outlook" | "imap" | "forward_alias";

interface EmailConnection {
  id: string;
  provider: Provider;
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
  forwardAddress?: string | null;
  forwardVerifyCode?: string | null;
  forwardVerifyUrl?: string | null;
  forwardVerifyAt?: string | null;
}

interface Job {
  id: string;
  title: string;
  status?: string;
}

interface Options {
  gmailOAuth: boolean;
  outlookOAuth: boolean;
  inboundDomain: string;
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
const noteCls = "rounded-2xl border border-[var(--warning-border)] bg-[var(--warning-soft)] px-4 py-3 text-sm text-[var(--warning)]";

const PROVIDER_LABEL: Record<Provider, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  imap: "Webmail",
  forward_alias: "Forwarding",
};

/**
 * IMAP servers for the hosts recruiters most often use. "Auto" is the cPanel /
 * Plesk convention of mail.<domain>, which covers most company webmail.
 */
const IMAP_PRESETS: { id: string; label: string; host: string | null }[] = [
  { id: "auto", label: "My company's webmail (cPanel, Plesk…)", host: null },
  { id: "gmail", label: "Gmail with an App Password", host: "imap.gmail.com" },
  { id: "zoho-in", label: "Zoho Mail (India)", host: "imap.zoho.in" },
  { id: "zoho", label: "Zoho Mail (global)", host: "imap.zoho.com" },
  { id: "hostinger", label: "Hostinger", host: "imap.hostinger.com" },
  { id: "godaddy", label: "GoDaddy", host: "imap.secureserver.net" },
  { id: "yahoo", label: "Yahoo Mail", host: "imap.mail.yahoo.com" },
  { id: "other", label: "Other (enter the server)", host: "" },
];

function MailIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="14" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="m4 7 8 6 8-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ForwardIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M14 5l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 11H10a6 6 0 0 0-6 6v1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function GoogleIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.8Z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9Z" />
    </svg>
  );
}

function MicrosoftIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
      <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
      <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
      <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
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

function ProviderIcon({ provider, className = "h-5 w-5" }: { provider: Provider; className?: string }) {
  if (provider === "gmail") return <GoogleIcon className={className} />;
  if (provider === "outlook") return <MicrosoftIcon className={className} />;
  if (provider === "forward_alias") return <ForwardIcon className={className} />;
  return <MailIcon className={className} />;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`${secondaryBtn} flex-none py-2`}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CheckIcon /> : null}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function EmailSettingsPage({ params }: { params: { tenant: string } }) {
  const t = useCopy();
  const { tenant } = params;

  const [connections, setConnections] = useState<EmailConnection[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // --- step 1: where applications go (shared by every method) ---------------
  const [jobId, setJobId] = useState("");
  const [autoRoute, setAutoRoute] = useState(false);

  // --- step 2: how the mail reaches Pratibha ---------------------------------
  const [method, setMethod] = useState<Provider>("gmail");

  // IMAP form
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  // Matches the default method, so the Gmail tab starts with Gmail's server.
  const [preset, setPreset] = useState("gmail");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(993);
  const [username, setUsername] = useState("");
  const [folder, setFolder] = useState("INBOX");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  // Forwarding form
  const [forwardFrom, setForwardFrom] = useState("");

  const load = useCallback(() => {
    fetch(`/api/${tenant}/email-connections`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        setConnections(data.connections ?? []);
        setJobs(data.jobs ?? []);
        setOptions(data.options ?? null);
      })
      .catch(() => setError("Failed to load email settings"));
  }, [tenant]);

  useEffect(load, [load]);

  // The Google/Microsoft sign-in comes back here with ?connected= or ?error=.
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const connected = search.get("connected");
    const failed = search.get("error");
    if (connected) setMessage(`Connected ${connected}. New mail will be picked up automatically.`);
    if (failed) setError(failed);
    if (connected || failed) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // A forwarding address waiting on Gmail's confirmation mail is checked again
  // every few seconds, so the code appears without a manual refresh.
  const awaitingMail = connections.some((c) => c.provider === "forward_alias" && !c.lastPollAt && !c.forwardVerifyCode);
  useEffect(() => {
    if (!awaitingMail) return;
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [awaitingMail, load]);

  // cPanel, Plesk and most hosts serve IMAP at mail.<domain>, so the server is
  // derived from the address and the user never has to know it.
  // A preset names the server outright; "other" leaves it to the user.
  const presetHost = IMAP_PRESETS.find((p) => p.id === preset)?.host;
  const guessedHost = useMemo(() => {
    if (presetHost != null) return presetHost;
    const domain = address.split("@")[1];
    return domain ? `mail.${domain}` : "";
  }, [address, presetHost]);
  const manualHost = showAdvanced || preset === "other";
  const effectiveHost = manualHost && host ? host : guessedHost;

  const jobChosen = Boolean(jobId);

  function startOAuth(provider: "gmail" | "outlook", loginHint?: string, forJob?: { jobId: string; autoRoute: boolean }) {
    const target = forJob ?? { jobId, autoRoute };
    const query = new URLSearchParams({ jobId: target.jobId, autoRoute: String(target.autoRoute) });
    if (loginHint) query.set("loginHint", loginHint);
    window.location.href = `/api/${tenant}/email-connections/oauth/${provider}?${query.toString()}`;
  }

  function imapPayload() {
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
        body: JSON.stringify(imapPayload()),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.message || "Could not test the mailbox");
      else setTest(data.result);
    } finally {
      setTesting(false);
    }
  }

  async function create(body: Record<string, unknown>, okMessage: string): Promise<boolean> {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/email-connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, defaultJobId: jobId, autoRoute }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not connect the mailbox");
        return false;
      }
      setMessage(okMessage);
      load();
      return true;
    } finally {
      setSaving(false);
    }
  }

  async function saveImap() {
    const ok = await create(
      { provider: "imap", ...imapPayload() },
      `Connected ${address}. New mail will be picked up automatically.`
    );
    if (ok) {
      setPassword("");
      setTest(null);
    }
  }

  async function createForward() {
    const ok = await create(
      { provider: "forward_alias", address: forwardFrom },
      "Forwarding address created. Follow the steps below it to switch forwarding on."
    );
    if (ok) setForwardFrom("");
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
    const what = conn.provider === "forward_alias" ? `the forwarding address for ${conn.address}` : conn.address;
    if (!window.confirm(`Disconnect ${what}? Candidates already imported are kept.`)) return;
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

  const methods: { id: Provider; title: string; desc: string }[] = [
    { id: "gmail", title: "Gmail", desc: "Gmail or Google Workspace" },
    { id: "outlook", title: "Outlook", desc: "Outlook.com or Microsoft 365" },
    { id: "imap", title: "Webmail", desc: "cPanel, Zoho, Hostinger, any IMAP" },
    { id: "forward_alias", title: "Forwarding", desc: "No password: forward mail to us" },
  ];

  const imapForm = (
    <>
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
            placeholder={preset === "gmail" ? "you@gmail.com" : "you@yourcompany.com"}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="password" className={labelCls}>
            {preset === "gmail" ? "App Password" : "Mailbox password"}
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder={preset === "gmail" ? "16-letter App Password" : "the password you use for webmail"}
            className={inputCls}
          />
          {preset === "gmail" && (
            <p className={hintCls}>
              Needs 2-Step Verification. Create one at{" "}
              <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">
                myaccount.google.com/apppasswords
              </a>
              , and make sure IMAP is on in Gmail settings.
            </p>
          )}
        </div>
      </div>

      {method === "imap" && (
        <div className="mt-5">
          <label htmlFor="preset" className={labelCls}>
            Mail host
          </label>
          <select
            id="preset"
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value);
              setHost("");
              setShowAdvanced(false);
            }}
            className={inputCls}
          >
            {IMAP_PRESETS.filter((p) => p.id !== "gmail").map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          if (!showAdvanced && !host) setHost(guessedHost);
          setShowAdvanced((v) => !v);
        }}
        className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--accent)] hover:text-[var(--accent-hover)]"
      >
        {showAdvanced ? "Hide" : "Show"} advanced settings
        <ChevronIcon open={showAdvanced} />
      </button>

      {manualHost ? (
        <div className="mt-4 space-y-5 rounded-2xl border-l-[3px] border-[var(--accent-border)] bg-[var(--surface-2)] p-4">
          <div>
            <label htmlFor="host" className={labelCls}>
              IMAP server
            </label>
            <input
              id="host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="mail.yourcompany.com"
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
        <button onClick={runTest} disabled={testing || !address || !password || !effectiveHost} className={secondaryBtn}>
          {testing && <Spinner />}
          {testing ? "Testing…" : "Test connection"}
        </button>
        <button onClick={saveImap} disabled={saving || !address || !password || !effectiveHost || !jobChosen} className={primaryBtn}>
          {saving && <Spinner />}
          {saving ? "Connecting…" : "Connect mailbox"}
        </button>
      </div>

      {test && (
        <div
          className={[
            "mt-4 rounded-2xl border p-4",
            test.ok ? "border-[var(--success-border)] bg-[var(--success-soft)]" : "border-[var(--danger-border)] bg-[var(--danger-soft)]",
          ].join(" ")}
        >
          {test.ok ? (
            <>
              <div className="flex items-center gap-2 font-semibold text-[var(--success)]">
                <CheckIcon />
                Signed in successfully.
              </div>
              <div className="mt-1.5 text-sm text-[var(--success)]">
                {test.messages} {test.messages === 1 ? "message" : "messages"} in {folder}.
              </div>
              {test.folders && test.folders.length > 0 && (
                <div className="mt-2 text-xs text-[var(--text-muted)]">Folders: {test.folders.slice(0, 12).join(", ")}</div>
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
        The password is encrypted before it is stored and is never shown again. On first connect, mail from the last 7
        days is imported.
      </p>
    </>
  );

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center gap-3">
        <div className="grid h-11 w-11 flex-none place-items-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white shadow-lg shadow-[var(--accent)]/25">
          <MailIcon />
        </div>
        <h1 className="!mb-0">{t("copy.portal.settings.email.title")}</h1>
      </div>
      <p className="muted mb-6">
        {t("copy.portal.settings.email.intro")}
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

      <div className="flex flex-col gap-6">
        <div className={cardCls}>
          <h3 className="mb-1 text-base font-semibold text-[var(--text)]">Connect a mailbox</h3>
          <p className="mb-5 text-sm text-[var(--text-muted)]">You can connect as many mailboxes as you like.</p>

          <label className={labelCls}>1. Which job do these applications belong to?</label>
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
                    selected ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent-border)]",
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
                  <p className="min-w-0 whitespace-normal break-words text-xs leading-relaxed text-[var(--text-muted)]">{opt.desc}</p>
                </button>
              );
            })}
          </div>

          <div className="mt-4">
            <label htmlFor="job" className="sr-only">
              Job
            </label>
            <select id="job" value={jobId} onChange={(e) => setJobId(e.target.value)} className={inputCls}>
              <option value="">{autoRoute ? "Fallback job (for mail that matches no role)…" : "File candidates into…"}</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                </option>
              ))}
            </select>
            {autoRoute && (
              <p className={hintCls}>
                Applications that do not clearly name a role land in the fallback job instead of being dropped, so nothing is lost.
              </p>
            )}
          </div>

          <label className={`${labelCls} mt-7`}>2. How should Pratibha get the mail?</label>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="tablist">
            {methods.map((m) => {
              const selected = method === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => {
                    setMethod(m.id);
                    setTest(null);
                    setPreset(m.id === "gmail" ? "gmail" : "auto");
                    setHost("");
                    setShowAdvanced(false);
                  }}
                  className={[
                    "!flex !w-full !min-w-0 !flex-col !items-start gap-2 rounded-2xl border p-4 text-left transition",
                    selected ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent-border)]",
                  ].join(" ")}
                >
                  <ProviderIcon provider={m.id} className={`h-6 w-6 ${selected ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}`} />
                  <span className="text-sm font-semibold text-[var(--text)]">{m.title}</span>
                  <span className="whitespace-normal text-xs leading-snug text-[var(--text-muted)]">{m.desc}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-6">
            {!jobChosen && (
              <p className={`${noteCls} mb-5`}>
                {jobs.length === 0 ? (
                  <>
                    You have no jobs yet, and every mailbox needs one to file applications into.{" "}
                    <a href={`/${tenant}/jobs/new`} className="font-semibold underline">
                      Create a job
                    </a>{" "}
                    first, then come back here.
                  </>
                ) : (
                  <>
                    Choose a job in step 1 above (<em>File candidates into…</em>) — the buttons below stay off until you do.
                  </>
                )}
              </p>
            )}

            {method === "gmail" && (
              <>
                {options?.gmailOAuth ? (
                  <>
                    <button type="button" disabled={!jobChosen} onClick={() => startOAuth("gmail")} className={secondaryBtn}>
                      <GoogleIcon />
                      Sign in with Google
                    </button>
                    <p className={hintCls}>
                      The safest way: no password is shared, and you can withdraw access any time from your Google account.
                    </p>
                    <div className="my-6 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                      <span className="h-px flex-1 bg-[var(--border)]" /> or use an App Password <span className="h-px flex-1 bg-[var(--border)]" />
                    </div>
                  </>
                ) : (
                  <p className={`${noteCls} mb-5`}>
                    Google sign-in is not switched on for this workspace yet. Use a Gmail App Password below, or forwarding.
                  </p>
                )}
                {imapForm}
              </>
            )}

            {method === "outlook" &&
              (options?.outlookOAuth ? (
                <>
                  <button type="button" disabled={!jobChosen} onClick={() => startOAuth("outlook")} className={secondaryBtn}>
                    <MicrosoftIcon />
                    Sign in with Microsoft
                  </button>
                  <p className={hintCls}>
                    Works with Outlook.com, Hotmail, Live and Microsoft 365 work accounts. For Microsoft 365, IMAP must be
                    allowed for the mailbox (it is by default).
                  </p>
                </>
              ) : (
                <p className={noteCls}>
                  Microsoft sign-in is not switched on for this workspace yet, and Outlook no longer accepts mailbox
                  passwords. Use <strong>Forwarding</strong> for now — it works with every Outlook account.
                </p>
              ))}

            {method === "imap" && imapForm}

            {method === "forward_alias" && (
              <>
                <p className="mb-4 text-sm text-[var(--text-muted)]">
                  Pratibha gives you a private address. Set your mailbox to forward to it — Gmail, Outlook, cPanel and
                  most webmail can — and every application is fetched straight from there. No password is shared.
                </p>
                <label htmlFor="forward-from" className={labelCls}>
                  Which mailbox will forward?
                </label>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <input
                    id="forward-from"
                    type="email"
                    value={forwardFrom}
                    onChange={(e) => setForwardFrom(e.target.value)}
                    placeholder="careers@yourcompany.com"
                    className={inputCls}
                  />
                  <button onClick={createForward} disabled={saving || !forwardFrom || !jobChosen} className={`${primaryBtn} flex-none`}>
                    {saving && <Spinner />}
                    Create forwarding address
                  </button>
                </div>
                {!jobChosen && forwardFrom && (
                  <p className="mt-1.5 text-xs font-semibold text-[var(--warning)]">
                    Pick a job in step 1 to turn this button on.
                  </p>
                )}
                <p className={hintCls}>
                  You will get an address like <code>{tenant}.xxxxxxxxxx@{options?.inboundDomain ?? "in.pratibha.tech"}</code>{" "}
                  and step-by-step instructions for your mail provider.
                </p>
              </>
            )}
          </div>
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
                <ConnectionRow
                  key={conn.id}
                  conn={conn}
                  jobs={jobs}
                  onPatch={patch}
                  onRemove={remove}
                  onReconnect={(c) =>
                    startOAuth(c.provider as "gmail" | "outlook", c.address, {
                      jobId: c.defaultJobId ?? "",
                      autoRoute: Boolean(c.autoRoute),
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ForwardingSetup({ conn }: { conn: EmailConnection }) {
  const [guide, setGuide] = useState<"gmail" | "outlook" | "cpanel">(
    /@(gmail|googlemail)\.com$/i.test(conn.address) ? "gmail" : /@(outlook|hotmail|live|msn)\./i.test(conn.address) ? "outlook" : "gmail"
  );
  const alias = conn.forwardAddress ?? "";

  const steps: Record<typeof guide, ReactNode[]> = {
    gmail: [
      <>In Gmail, open <strong>Settings → See all settings → Forwarding and POP/IMAP</strong>.</>,
      <>Click <strong>Add a forwarding address</strong>, paste the address above, then <strong>Next → Proceed</strong>.</>,
      <>Gmail sends a confirmation code to Pratibha. It appears on this card within a minute — enter it in Gmail and click <strong>Verify</strong>.</>,
      <>Choose <strong>Forward a copy of incoming mail to</strong> this address, keep Gmail&apos;s copy in the inbox, and <strong>Save changes</strong>.</>,
      <>Only want applications? Instead of forwarding everything, create a filter (e.g. <em>Has attachment</em>) with the action <strong>Forward it to</strong> this address.</>,
    ],
    outlook: [
      <>In Outlook on the web, open <strong>Settings → Mail → Forwarding</strong>.</>,
      <>Turn on <strong>Enable forwarding</strong>, paste the address above, tick <strong>Keep a copy of forwarded messages</strong>, and <strong>Save</strong>.</>,
      <>Using a rule instead? Pick the action <strong>Redirect to</strong> rather than &quot;Forward to&quot;, so the applicant stays the sender.</>,
      <>Microsoft 365 work accounts: if forwarded mail never arrives, your admin must allow automatic external forwarding (Microsoft Defender → Anti-spam → Outbound policy).</>,
    ],
    cpanel: [
      <>In cPanel, open <strong>Email → Forwarders → Add Forwarder</strong>.</>,
      <>Enter your mailbox ({conn.address}) as the address to forward, choose <strong>Forward to email address</strong>, paste the address above, and click <strong>Add Forwarder</strong>.</>,
      <>Using Roundcube webmail instead? <strong>Settings → Filters</strong>, add a filter with the action <strong>Redirect message to</strong> this address.</>,
    ],
  };

  return (
    <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <label className={labelCls}>Forward {conn.address} to</label>
      <div className="flex items-center gap-2">
        <code className="block min-w-0 flex-1 break-all rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--text)]">
          {alias}
        </code>
        <CopyButton value={alias} />
      </div>
      <p className={hintCls}>Keep this address private: anything sent to it is filed as an application.</p>

      {(conn.forwardVerifyCode || conn.forwardVerifyUrl) && (
        <div className="mt-4 rounded-2xl border border-[var(--success-border)] bg-[var(--success-soft)] p-4 text-sm text-[var(--success)]">
          <strong>Gmail sent a confirmation{conn.forwardVerifyAt ? <> (<Time value={conn.forwardVerifyAt} format="ago" />)</> : null}.</strong>
          {conn.forwardVerifyCode && (
            <div className="mt-2 flex items-center gap-2">
              Code: <code className="rounded-lg bg-[var(--surface)] px-2 py-1 text-base font-bold tracking-wider text-[var(--text)]">{conn.forwardVerifyCode}</code>
              <CopyButton value={conn.forwardVerifyCode} />
            </div>
          )}
          {conn.forwardVerifyUrl && (
            <div className="mt-2">
              Or{" "}
              <a href={conn.forwardVerifyUrl} target="_blank" rel="noreferrer" className="font-semibold underline">
                confirm forwarding in Gmail
              </a>{" "}
              while signed in to {conn.address}.
            </div>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2" role="tablist">
        {(["gmail", "outlook", "cpanel"] as const).map((g) => (
          <button
            key={g}
            type="button"
            role="tab"
            aria-selected={guide === g}
            onClick={() => setGuide(g)}
            className={[
              "rounded-full border px-3 py-1 text-xs font-semibold transition",
              guide === g ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent-border)]",
            ].join(" ")}
          >
            {g === "gmail" ? "Gmail" : g === "outlook" ? "Outlook / Microsoft 365" : "cPanel / webmail"}
          </button>
        ))}
      </div>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-[var(--text)]">
        {steps[guide].map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

function ConnectionRow({
  conn,
  jobs,
  onPatch,
  onRemove,
  onReconnect,
}: {
  conn: EmailConnection;
  jobs: Job[];
  onPatch: (id: string, body: Record<string, unknown>, okMessage: string) => Promise<void>;
  onRemove: (conn: EmailConnection) => Promise<void>;
  onReconnect: (conn: EmailConnection) => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const isForward = conn.provider === "forward_alias";
  const isOAuth = conn.provider === "gmail" || conn.provider === "outlook";
  // A new forwarding address opens with its setup steps showing.
  const [open, setOpen] = useState(isForward && !conn.lastPollAt);

  const paused = conn.paused ?? conn.status === "revoked";
  const waiting = isForward && !conn.lastPollAt && !paused && conn.status !== "error";
  const badge = paused
    ? { text: "Paused", cls: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]" }
    : conn.status === "error"
      ? { text: "Error", cls: "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]" }
      : waiting
        ? { text: "Waiting for mail", cls: "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]" }
        : { text: "Active", cls: "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]" };
  const dotCls = paused
    ? "bg-[var(--text-subtle)]"
    : conn.status === "error"
      ? "bg-[var(--danger)]"
      : waiting
        ? "bg-[var(--warning)]"
        : "bg-[var(--success)]";

  const how =
    conn.provider === "gmail"
      ? "Google sign-in"
      : conn.provider === "outlook"
        ? "Microsoft sign-in"
        : isForward
          ? "forwarding"
          : `${conn.imapHost}:${conn.imapPort} · ${conn.folder}`;

  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-10 w-10 flex-none place-items-center rounded-xl border border-[var(--border)] bg-[var(--surface-2)] text-[var(--accent)]">
            <ProviderIcon provider={conn.provider} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="truncate text-sm text-[var(--text)]">{conn.address}</strong>
              <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-muted)]">
                {PROVIDER_LABEL[conn.provider] ?? conn.provider}
              </span>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badge.cls}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${dotCls}`} />
                {badge.text}
              </span>
            </div>
            <div className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
              {how} · {conn.autoRoute ? "all jobs" : "one job"}
              {conn.lastPollAt && (
                <>
                  {" "}
                  · {isForward ? "last mail" : "last checked"} <Time value={conn.lastPollAt} />
                </>
              )}
            </div>
            {conn.errorDetail && <div className="mt-0.5 text-xs text-[var(--danger)]">{conn.errorDetail}</div>}
          </div>
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} className={`${secondaryBtn} flex-none py-2`}>
          {open ? "Close" : "Manage"}
          <ChevronIcon open={open} className="h-3.5 w-3.5" />
        </button>
      </div>

      {isForward && open && <ForwardingSetup conn={conn} />}

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
                    e.target.value === "auto" ? "Now matching applications to all open jobs." : "Now filing everything into one job."
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

          {conn.provider === "imap" && (
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
          )}

          <div className="mt-5 flex flex-wrap gap-3">
            {conn.provider === "imap" && (
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
            )}

            {isOAuth && (
              <button onClick={() => onReconnect(conn)} className={primaryBtn}>
                Sign in again
              </button>
            )}

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
