"use client";

import { useEffect, useState } from "react";

/**
 * Compose and send one email to one candidate.
 *
 * Templates are offered as a starting point rather than sent as-is: the reason
 * to email someone by hand is usually that none of the stock messages quite
 * fit. Picking one fills the boxes and leaves them editable.
 */

interface Template {
  id: string;
  type: string;
  subject: string;
  bodyMd: string;
}

interface Props {
  tenant: string;
  candidate: { id: string; name?: string | null; email?: string | null };
  onClose: () => void;
  onSent: (message: string) => void;
}

const TEMPLATE_LABELS: Record<string, string> = {
  interview_invite: "Interview invite",
  rejection: "Rejection",
  reminder: "Reminder",
};

export default function EmailCandidate({ tenant, candidate, onClose, onSent }: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/${tenant}/outreach-templates`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setTemplates(d.templates ?? []))
      .catch(() => {
        // Templates are a convenience; the recruiter can still write their own.
      });
  }, [tenant]);

  // Escape closes, matching every other dialog the user has ever used.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function applyTemplate(template: Template) {
    setSubject(template.subject);
    setBody(template.bodyMd);
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/${tenant}/candidates/${candidate.id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "The email could not be sent");

      onSent(
        data.logOnly
          ? `Logged only — no mail provider is configured, so nothing was delivered to ${data.to}.`
          : `Email sent to ${data.to}${data.via === "mailbox" ? " from your connected mailbox" : ""}.`
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The email could not be sent");
    } finally {
      setBusy(false);
    }
  }

  const who = candidate.name || candidate.email || "this candidate";

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Email ${who}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ marginBottom: 4 }}>
          <strong>Email {who}</strong>
          <button className="ghost sm" style={{ marginLeft: "auto" }} onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        <p className="subtle" style={{ marginTop: 0, marginBottom: 14 }}>
          To {candidate.email}. Sent from your connected mailbox, so replies come
          back to you.
        </p>

        {error && <div className="notice notice-error" style={{ marginBottom: 12 }}>{error}</div>}

        {templates.length > 0 && (
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="subtle">Start from:</span>
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="sm"
                onClick={() => applyTemplate(template)}
                disabled={busy}
              >
                {TEMPLATE_LABELS[template.type] ?? template.type}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={send} className="stack">
          <div>
            <label htmlFor="email-subject">Subject</label>
            <input
              id="email-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="About your application"
              required
            />
          </div>
          <div>
            <label htmlFor="email-body">Message</label>
            <textarea
              id="email-body"
              rows={12}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message. {{candidateName}}, {{jobTitle}} and {{companyName}} are filled in when it sends."
              required
            />
          </div>
          <div className="row">
            <button className="primary" type="submit" disabled={busy || !subject || !body}>
              {busy ? "Sending…" : "Send email"}
            </button>
            <span className="subtle">
              {"{{candidateName}}, {{jobTitle}} and {{companyName}} are replaced when it sends."}
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
