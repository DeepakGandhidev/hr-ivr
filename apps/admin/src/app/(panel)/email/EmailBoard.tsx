"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useToast } from "@/components/ui";

type Kind = { key: string; group: string; label: string; to: string; when: string; required?: boolean; on: boolean };
type LogRow = { id: string; kind: string; to: string; subject: string; status: string; error: string | null; at: string };

const STATUS_CHIP: Record<string, string> = {
  sent: "chip-green",
  failed: "chip-red",
  skipped: "chip-neutral",
  sending: "chip-amber",
};

export function EmailBoard({
  mailbox,
  canConnect,
  canEdit,
  ownerRefusal,
  adminEmail,
  groups,
  kinds,
  week,
  recent,
}: {
  mailbox: { address: string; host: string; port: number } | null;
  canConnect: boolean;
  canEdit: boolean;
  ownerRefusal: string;
  adminEmail: string;
  groups: { id: string; label: string }[];
  kinds: Kind[];
  week: Record<string, number>;
  recent: LogRow[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(!mailbox);
  const [address, setAddress] = useState(mailbox?.address ?? "info@pratibha.tech");
  const [password, setPassword] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [host, setHost] = useState(mailbox?.host ?? "");
  const [port, setPort] = useState(mailbox ? String(mailbox.port) : "");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const labelOf = Object.fromEntries(kinds.map((k) => [k.key, k.label]));

  async function run(name: string, path: string, body: unknown) {
    setBusy(name);
    setNotice(null);
    try {
      const res = await api<{ message: string }>(path, body);
      setNotice({ ok: true, text: res.message });
      setPassword("");
      if (name === "connect" || name === "disconnect") setEditing(name === "disconnect");
      router.refresh();
    } catch (err) {
      setNotice({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function toggle(kind: Kind, on: boolean) {
    try {
      await api("/api/settings", { set: { [`emails.${kind.key}`]: on } });
      toast.show(`${kind.label}: ${on ? "on" : "off"}.`);
      router.refresh();
    } catch (err) {
      toast.show((err as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Email</h1>
          <p className="page-sub">Every email Pratibha sends goes out from one mailbox. Connect it with its address and password.</p>
        </div>
      </div>

      <div className="card card-pad" style={{ gap: 12 }}>
        <div className="card-row">
          <div className="grow">
            <div className="card-title">Sending mailbox</div>
            {mailbox ? (
              <div style={{ marginTop: 4, fontSize: 14 }}>
                <span className="chip sm chip-green">Connected</span> <strong>{mailbox.address}</strong>{" "}
                <span className="cell-muted">via {mailbox.host}:{mailbox.port}</span>
              </div>
            ) : (
              <div style={{ marginTop: 4 }}>
                <span className="chip sm chip-red">Not connected</span>{" "}
                <span className="cell-muted">No email goes out until a mailbox is connected.</span>
              </div>
            )}
          </div>
          {mailbox && !editing && (
            <>
              {canEdit && (
                <button className="btn md" onClick={() => run("test", "/api/email/test", {})} disabled={busy !== null}>
                  {busy === "test" ? "Sending…" : `Send a test to ${adminEmail}`}
                </button>
              )}
              {canConnect && (
                <button className="btn md" onClick={() => setEditing(true)} disabled={busy !== null}>Change</button>
              )}
            </>
          )}
        </div>

        {editing && (canConnect ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run("connect", "/api/email/connect", {
                address,
                password,
                ...(advanced && host ? { host } : {}),
                ...(advanced && port ? { port: Number(port) } : {}),
              });
            }}
            style={{ display: "grid", gap: 12, maxWidth: 560 }}
          >
            <div className="grid-2">
              <div className="field">
                <label className="label" htmlFor="mb-address">Email address</label>
                <input id="mb-address" className="input" type="email" value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" required />
              </div>
              <div className="field">
                <label className="label" htmlFor="mb-password">Password</label>
                <input id="mb-password" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
              </div>
            </div>
            <button type="button" className="hint" onClick={() => setAdvanced((v) => !v)}
              style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", color: "var(--amber-link)", fontWeight: 600 }}>
              {advanced ? "Hide" : "Not on Hostinger? Set the mail server"}
            </button>
            {advanced && (
              <div className="grid-2">
                <div className="field">
                  <label className="label" htmlFor="mb-host">SMTP server</label>
                  <input id="mb-host" className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.hostinger.com" />
                </div>
                <div className="field">
                  <label className="label" htmlFor="mb-port">Port</label>
                  <input id="mb-port" className="input" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="465" />
                </div>
              </div>
            )}
            <div className="card-row">
              <button className="btn btn-primary md" type="submit" disabled={busy !== null}>
                {busy === "connect" ? "Checking with the mail server…" : "Connect and send a test"}
              </button>
              {mailbox && (
                <button type="button" className="btn md" onClick={() => setEditing(false)} disabled={busy !== null}>Cancel</button>
              )}
              <div className="grow" />
              {mailbox && (
                <button type="button" className="btn btn-danger md" disabled={busy !== null}
                  onClick={() => window.confirm("Disconnect the mailbox? Pratibha stops sending email.") && run("disconnect", "/api/email/disconnect", {})}>
                  Disconnect
                </button>
              )}
            </div>
            <div className="hint">The password is checked with the mail server before it is saved, stored encrypted, and never shown again.</div>
          </form>
        ) : (
          <div className="notice">{ownerRefusal}</div>
        ))}

        {notice && <div className={`notice ${notice.ok ? "notice-ok" : "notice-error"}`} role="status">{notice.text}</div>}
      </div>

      <div className="grid-4">
        <div className="kpi"><div className="kpi-value">{week.sent ?? 0}</div><div className="kpi-label">Sent, last 7 days</div></div>
        <div className="kpi"><div className={`kpi-value${week.failed ? " warn" : ""}`}>{week.failed ?? 0}</div><div className="kpi-label">Failed, last 7 days</div></div>
        <div className="kpi"><div className="kpi-value">{week.skipped ?? 0}</div><div className="kpi-label">Not sent (switched off)</div></div>
        <div className="kpi"><div className="kpi-value">{kinds.filter((k) => k.on).length} / {kinds.length}</div><div className="kpi-label">Emails switched on</div></div>
      </div>

      <div className="card card-pad" style={{ gap: 0 }}>
        <div className="card-title" style={{ marginBottom: 6 }}>Every email Pratibha sends</div>
        {groups.map((g) => (
          <div key={g.id} style={{ marginTop: 10 }}>
            <div className="label" style={{ marginBottom: 4 }}>{g.label}</div>
            {kinds.filter((k) => k.group === g.id).map((k) => (
              <div key={k.key} className="card-row" style={{ borderTop: "1px solid var(--line-soft)", padding: "9px 0", alignItems: "flex-start" }}>
                <div className="grow">
                  <div className="cell-strong" style={{ fontSize: 13.5 }}>{k.label}</div>
                  <div className="cell-sub">To {k.to.charAt(0).toLowerCase() + k.to.slice(1)} · {k.when}</div>
                </div>
                {k.required ? (
                  <span className="chip sm chip-neutral" title="People need this one to get into their account">Always on</span>
                ) : (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <input type="checkbox" checked={k.on} disabled={!canEdit} onChange={(e) => void toggle(k, e.target.checked)}
                      style={{ width: 16, height: 16, accentColor: "#1E1B4B" }} />
                    {k.on ? "On" : "Off"}
                  </label>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="table">
        <div className="trow head" style={{ gridTemplateColumns: "150px 1fr 1.2fr 90px" }}>
          <div>When</div><div>Email</div><div>To</div><div>Result</div>
        </div>
        {recent.length === 0 && <div className="empty"><strong>Nothing sent yet</strong>Emails appear here as Pratibha sends them.</div>}
        {recent.map((r) => (
          <div key={r.id} className="trow" style={{ gridTemplateColumns: "150px 1fr 1.2fr 90px" }}>
            <div className="cell-muted" suppressHydrationWarning>{new Date(r.at).toLocaleString()}</div>
            <div>
              <div className="cell-strong" style={{ fontSize: 13 }}>{labelOf[r.kind] ?? r.kind}</div>
              <div className="cell-sub" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.subject}</div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>{r.to}</div>
              {r.error && <div className="cell-sub" style={{ color: "var(--red)" }}>{r.error}</div>}
            </div>
            <div><span className={`chip sm ${STATUS_CHIP[r.status] ?? "chip-neutral"}`}>{r.status}</span></div>
          </div>
        ))}
      </div>
      {toast.node}
    </>
  );
}
