"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useToast } from "@/components/ui";

type Connection = {
  phoneNumberId: string;
  wabaId: string;
  hasAppSecret: boolean;
  number: string | null;
  verifiedName: string | null;
  quality: string | null;
  error: string | null;
};
type Template = {
  key: string;
  label: string;
  group: string;
  to: string;
  when: string;
  required: boolean;
  name: string;
  language: string;
  state: string;
  vars: string[];
  body: string;
  problem: string | null;
  on: boolean;
};
type LogRow = { id: string; kind: string; to: string; template: string | null; status: string; error: string | null; at: string };

const STATUS_CHIP: Record<string, string> = {
  sent: "chip-neutral",
  delivered: "chip-green",
  read: "chip-green",
  failed: "chip-red",
  skipped: "chip-neutral",
  sending: "chip-amber",
};

const TEMPLATE_CHIP: Record<string, string> = {
  APPROVED: "chip-green",
  PENDING: "chip-amber",
  IN_APPEAL: "chip-amber",
  REJECTED: "chip-red",
  DISABLED: "chip-red",
  PAUSED: "chip-red",
  MISSING: "chip-red",
};

const QUALITY_CHIP: Record<string, string> = { GREEN: "chip-green", YELLOW: "chip-amber", RED: "chip-red" };

export function WhatsAppBoard({
  connection,
  callbackUrl,
  verifyToken,
  canConnect,
  canEdit,
  ownerRefusal,
  groups,
  templates,
  templateError,
  candidatesNeedOptIn,
  week,
  recent,
}: {
  connection: Connection | null;
  callbackUrl: string;
  verifyToken: string;
  canConnect: boolean;
  canEdit: boolean;
  ownerRefusal: string;
  groups: { id: string; label: string }[];
  templates: Template[];
  templateError: string | null;
  candidatesNeedOptIn: boolean;
  week: Record<string, number>;
  recent: LogRow[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(!connection);
  const [phoneNumberId, setPhoneNumberId] = useState(connection?.phoneNumberId ?? "");
  const [wabaId, setWabaId] = useState(connection?.wabaId ?? "");
  const [token, setToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [testPhone, setTestPhone] = useState("");
  // Templates a test can use: approved by Meta with the right number of values.
  const testable = templates.filter((t) => t.state === "APPROVED" && !t.problem);
  const [testKind, setTestKind] = useState(testable.find((t) => !t.required)?.key ?? testable[0]?.key ?? "test");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const labelOf = Object.fromEntries(templates.map((t) => [t.key, t.label]));

  async function run(name: string, path: string, body: unknown) {
    setBusy(name);
    setNotice(null);
    try {
      const res = await api<{ message: string }>(path, body);
      setNotice({ ok: true, text: res.message });
      setToken("");
      setAppSecret("");
      if (name === "connect" || name === "disconnect") setEditing(name === "disconnect");
      router.refresh();
    } catch (err) {
      setNotice({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function save(key: string, on: boolean, note: string) {
    try {
      await api("/api/settings", { set: { [key]: on } });
      toast.show(note);
      router.refresh();
    } catch (err) {
      toast.show((err as Error).message);
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.show(`${what} copied.`);
    } catch {
      toast.show("Copying was blocked; select the text instead.");
    }
  }

  const approved = templates.filter((t) => t.state === "APPROVED" && !t.problem).length;

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">WhatsApp</h1>
          <p className="page-sub">
            Alerts to hiring teams and interview invites to candidates, from Pratibha&apos;s WhatsApp Business number through
            Meta&apos;s Cloud API. Every message is a template Meta has approved.
          </p>
        </div>
      </div>

      <div className="card card-pad" style={{ gap: 12 }}>
        <div className="card-row">
          <div className="grow">
            <div className="card-title">Sending number</div>
            {connection ? (
              <div style={{ marginTop: 4, fontSize: 14 }}>
                <span className={`chip sm ${connection.error ? "chip-red" : "chip-green"}`}>{connection.error ? "Meta refused" : "Connected"}</span>{" "}
                <strong>{connection.number ?? connection.phoneNumberId}</strong>{" "}
                {connection.verifiedName && <span className="cell-muted">{connection.verifiedName}</span>}{" "}
                {connection.quality && (
                  <span className={`chip sm ${QUALITY_CHIP[connection.quality] ?? "chip-neutral"}`} title="Meta's quality rating for this number">
                    Quality {connection.quality.toLowerCase()}
                  </span>
                )}
                {connection.error && <div className="cell-sub" style={{ color: "var(--red)", marginTop: 4 }}>{connection.error}</div>}
                {!connection.hasAppSecret && (
                  <div className="cell-sub" style={{ color: "var(--red)", marginTop: 4 }}>
                    No app secret is saved, so webhook calls cannot be checked. Reconnect with it.
                  </div>
                )}
              </div>
            ) : (
              <div style={{ marginTop: 4 }}>
                <span className="chip sm chip-red">Not connected</span>{" "}
                <span className="cell-muted">No WhatsApp message goes out until a number is connected.</span>
              </div>
            )}
          </div>
          {connection && !editing && canConnect && (
            <button className="btn md" onClick={() => setEditing(true)} disabled={busy !== null}>Change</button>
          )}
        </div>

        {editing && (canConnect ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run("connect", "/api/whatsapp/connect", { phoneNumberId, wabaId, token, appSecret });
            }}
            style={{ display: "grid", gap: 12, maxWidth: 640 }}
          >
            <div className="grid-2">
              <div className="field">
                <label className="label" htmlFor="wa-phone-id">Phone number ID</label>
                <input id="wa-phone-id" className="input" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoComplete="off" required />
              </div>
              <div className="field">
                <label className="label" htmlFor="wa-waba">WhatsApp Business Account ID</label>
                <input id="wa-waba" className="input" value={wabaId} onChange={(e) => setWabaId(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoComplete="off" required />
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label className="label" htmlFor="wa-token">Permanent access token</label>
                <input id="wa-token" className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" required />
              </div>
              <div className="field">
                <label className="label" htmlFor="wa-secret">App secret</label>
                <input id="wa-secret" className="input" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} autoComplete="new-password" required />
              </div>
            </div>
            <div className="card-row">
              <button className="btn btn-primary md" type="submit" disabled={busy !== null}>
                {busy === "connect" ? "Checking with Meta…" : "Connect"}
              </button>
              {connection && (
                <button type="button" className="btn md" onClick={() => setEditing(false)} disabled={busy !== null}>Cancel</button>
              )}
              <div className="grow" />
              {connection && (
                <button type="button" className="btn btn-danger md" disabled={busy !== null}
                  onClick={() => window.confirm("Disconnect WhatsApp? Pratibha stops sending WhatsApp messages.") && run("disconnect", "/api/whatsapp/disconnect", {})}>
                  Disconnect
                </button>
              )}
            </div>
            <div className="hint">
              The IDs are on WhatsApp Manager&apos;s API Setup page; the token is a system user&apos;s permanent token with
              whatsapp_business_messaging and whatsapp_business_management; the app secret is under App settings → Basic. The token
              is checked with Meta before it is saved; both secrets are stored encrypted and never shown again.
            </div>
          </form>
        ) : (
          <div className="notice">{ownerRefusal}</div>
        ))}

        {notice && <div className={`notice ${notice.ok ? "notice-ok" : "notice-error"}`} role="status">{notice.text}</div>}
      </div>

      <div className="card card-pad" style={{ gap: 10 }}>
        <div className="card-title">Webhook (delivery reports and STOP replies)</div>
        <div className="hint">
          In the Meta app: WhatsApp → Configuration → Webhook. Paste these two, press Verify and save, then subscribe to the{" "}
          <strong>messages</strong> field.
        </div>
        <div className="card-row" style={{ gap: 8 }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="label">Callback URL</div>
            <code style={{ fontSize: 13, wordBreak: "break-all" }}>{callbackUrl}</code>
          </div>
          <button className="btn md" type="button" onClick={() => void copy(callbackUrl, "Callback URL")}>Copy</button>
        </div>
        <div className="card-row" style={{ gap: 8 }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="label">Verify token</div>
            {verifyToken ? (
              <code style={{ fontSize: 13, wordBreak: "break-all" }}>{verifyToken}</code>
            ) : (
              <span className="cell-muted">Made when WhatsApp is connected.</span>
            )}
          </div>
          {verifyToken && <button className="btn md" type="button" onClick={() => void copy(verifyToken, "Verify token")}>Copy</button>}
        </div>
      </div>

      {connection && canEdit && (
        <div className="card card-pad" style={{ gap: 10 }}>
          <div className="card-title">Send a test</div>
          <form
            className="card-row"
            style={{ gap: 8, alignItems: "flex-end" }}
            onSubmit={(e) => {
              e.preventDefault();
              void run("test", "/api/whatsapp/test", { phone: testPhone, kind: testKind });
            }}
          >
            <div className="field" style={{ maxWidth: 260 }}>
              <label className="label" htmlFor="wa-test">Mobile number</label>
              <input id="wa-test" className="input" type="tel" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="98765 43210" required />
            </div>
            <div className="field" style={{ maxWidth: 360 }}>
              <label className="label" htmlFor="wa-test-kind">Template</label>
              <select id="wa-test-kind" className="input" value={testKind} onChange={(e) => setTestKind(e.target.value)}>
                {(testable.length ? testable : templates.filter((t) => t.required)).map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label} ({t.name})
                  </option>
                ))}
              </select>
            </div>
            <button className="btn md" type="submit" disabled={busy !== null}>{busy === "test" ? "Sending…" : "Send test"}</button>
          </form>
          <div className="hint">
            Sends the chosen template filled with sample values (Asha Verma, Sales Executive, Pratibha Test…). It is logged as a test, never as a real
            invite or alert. Until the number is live, Meta only delivers to numbers added as test recipients.
          </div>
        </div>
      )}

      <div className="grid-4">
        <div className="kpi"><div className="kpi-value">{(week.sent ?? 0) + (week.delivered ?? 0) + (week.read ?? 0)}</div><div className="kpi-label">Sent, last 7 days</div></div>
        <div className="kpi"><div className="kpi-value">{(week.delivered ?? 0) + (week.read ?? 0)}</div><div className="kpi-label">Delivered, last 7 days</div></div>
        <div className="kpi"><div className={`kpi-value${week.failed ? " warn" : ""}`}>{week.failed ?? 0}</div><div className="kpi-label">Failed, last 7 days</div></div>
        <div className="kpi"><div className="kpi-value">{approved} / {templates.length}</div><div className="kpi-label">Templates approved</div></div>
      </div>

      <div className="card card-pad" style={{ gap: 0 }}>
        <div className="card-title" style={{ marginBottom: 6 }}>Every WhatsApp message Pratibha sends</div>
        {templateError && <div className="notice notice-error" style={{ marginTop: 6 }}>{templateError}</div>}
        {groups.map((g) => (
          <div key={g.id} style={{ marginTop: 10 }}>
            <div className="label" style={{ marginBottom: 4 }}>{g.label}</div>
            {templates.filter((t) => t.group === g.id).map((t) => (
              <div key={t.key} style={{ borderTop: "1px solid var(--line-soft)", padding: "9px 0" }}>
                <div className="card-row" style={{ alignItems: "flex-start" }}>
                  <div className="grow">
                    <div className="cell-strong" style={{ fontSize: 13.5 }}>
                      {t.label}{" "}
                      <span className={`chip sm ${TEMPLATE_CHIP[t.state] ?? "chip-neutral"}`} title={`${t.name} (${t.language}) in Meta`}>
                        {t.state === "UNKNOWN" ? "Not checked" : t.state}
                      </span>
                    </div>
                    <div className="cell-sub">To {t.to.charAt(0).toLowerCase() + t.to.slice(1)} · {t.when}</div>
                    <div className="cell-sub">
                      Template <code>{t.name}</code>, language <code>{t.language}</code>
                      {t.vars.length > 0 && <> · values: {t.vars.map((v, i) => `{{${i + 1}}} ${v}`).join(", ")}</>}
                    </div>
                    {t.problem && <div className="cell-sub" style={{ color: "var(--red)" }}>{t.problem}</div>}
                  </div>
                  {t.required ? (
                    <span className="chip sm chip-neutral">Always on</span>
                  ) : (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                      <input type="checkbox" checked={t.on} disabled={!canEdit}
                        onChange={(e) => void save(`whatsapp.send.${t.key}`, e.target.checked, `${t.label}: ${e.target.checked ? "on" : "off"}.`)}
                        style={{ width: 16, height: 16, accentColor: "#1E1B4B" }} />
                      {t.on ? "On" : "Off"}
                    </label>
                  )}
                </div>
                {t.body && (t.state === "MISSING" || t.state === "REJECTED") && (
                  <div className="notice" style={{ marginTop: 8, display: "grid", gap: 6 }}>
                    <div>
                      Create it in WhatsApp Manager → Message templates: name <code>{t.name}</code>, category Utility, language{" "}
                      <code>{t.language}</code>, with this body (and a sample for each value):
                    </div>
                    <code style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{t.body}</code>
                    <div>
                      <button type="button" className="btn sm" onClick={() => void copy(t.body, "Template body")}>Copy the body</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="card card-pad" style={{ gap: 6 }}>
        <div className="card-row" style={{ alignItems: "flex-start" }}>
          <div className="grow">
            <div className="card-title">Only message candidates who opted in</div>
            <div className="cell-sub">
              On: the interview invite goes on WhatsApp only to candidates who asked for updates (by sending START to the number).
              Off: to every invited candidate with a phone number. Anyone who replied STOP is never messaged either way.
            </div>
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={candidatesNeedOptIn} disabled={!canEdit}
              onChange={(e) => void save("whatsapp.candidates_need_opt_in", e.target.checked, e.target.checked ? "Candidates must opt in." : "Every invited candidate with a number gets WhatsApp.")}
              style={{ width: 16, height: 16, accentColor: "#1E1B4B" }} />
            {candidatesNeedOptIn ? "On" : "Off"}
          </label>
        </div>
      </div>

      <div className="table">
        <div className="trow head" style={{ gridTemplateColumns: "150px 1fr 1fr 90px" }}>
          <div>When</div><div>Message</div><div>To</div><div>Result</div>
        </div>
        {recent.length === 0 && <div className="empty"><strong>Nothing sent yet</strong>Messages appear here as Pratibha sends them.</div>}
        {recent.map((r) => (
          <div key={r.id} className="trow" style={{ gridTemplateColumns: "150px 1fr 1fr 90px" }}>
            <div className="cell-muted" suppressHydrationWarning>{new Date(r.at).toLocaleString()}</div>
            <div>
              <div className="cell-strong" style={{ fontSize: 13 }}>{labelOf[r.kind] ?? r.kind}</div>
              {r.template && <div className="cell-sub">{r.template}</div>}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>{r.to}</div>
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
