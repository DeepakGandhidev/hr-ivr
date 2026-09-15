"use client";

import { useEffect, useState } from "react";

type TemplateType = "interview_invite" | "rejection" | "reminder";

interface OutreachTemplate {
  id: string;
  type: TemplateType;
  subject: string;
  bodyMd: string;
}

const DEFAULT_TEMPLATES: Record<TemplateType, { subject: string; bodyMd: string }> = {
  interview_invite: {
    subject: "Interview invitation from {{companyName}} for {{jobTitle}}",
    bodyMd: `Hi {{candidateName}},

Thank you for applying for {{jobTitle}} at {{companyName}}.

We would like to invite you for a first-round screening interview with Pratibha, our AI hiring assistant.

Please call {{pratibhaNumber}} and use reference code {{referenceCode}} when prompted.

Best regards,
{{companyName}} Hiring Team`,
  },
  rejection: {
    subject: "Update on your application for {{jobTitle}}",
    bodyMd: `Hi {{candidateName}},

Thank you for your interest in {{jobTitle}} at {{companyName}}.

After careful review, we have decided not to move forward with your application at this time.

We wish you the best in your search.

Best regards,
{{companyName}} Hiring Team`,
  },
  reminder: {
    subject: "Reminder: Your Pratibha interview for {{jobTitle}}",
    bodyMd: `Hi {{candidateName}},

This is a friendly reminder to complete your Pratibha screening interview for {{jobTitle}} at {{companyName}}.

Call {{pratibhaNumber}} and use reference code {{referenceCode}}.

Best regards,
{{companyName}} Hiring Team`,
  },
};

// Labels + a short description for each tab. Purely presentational — the
// underlying `type` values are unchanged so nothing about the API contract
// or the templates map shifts.
const TYPE_META: Record<TemplateType, { label: string; hint: string }> = {
  interview_invite: { label: "Interview invite", hint: "Sent when a candidate is moved to screening." },
  rejection: { label: "Rejection", hint: "Sent when an application won't move forward." },
  reminder: { label: "Reminder", hint: "Sent to nudge a candidate who hasn't completed screening." },
};

const PLACEHOLDER_TOKENS = [
  "{{candidateName}}",
  "{{companyName}}",
  "{{jobTitle}}",
  "{{pratibhaNumber}}",
  "{{referenceCode}}",
];

export default function TemplatesPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const [templates, setTemplates] = useState<Partial<Record<TemplateType, OutreachTemplate>>>({});
  const [saving, setSaving] = useState<TemplateType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<TemplateType>("interview_invite");

  useEffect(() => {
    fetch(`/api/${tenant}/outreach-templates`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { templates?: OutreachTemplate[] }) => {
        const map: Partial<Record<TemplateType, OutreachTemplate>> = {};
        for (const t of data.templates ?? []) {
          map[t.type] = t;
        }
        for (const type of Object.keys(DEFAULT_TEMPLATES) as TemplateType[]) {
          if (!map[type]) {
            map[type] = { id: "", type, ...DEFAULT_TEMPLATES[type] };
          }
        }
        setTemplates(map);
      })
      .catch(() => setError("Failed to load templates"));
  }, [tenant]);

  function updateTemplate(type: TemplateType, field: "subject" | "bodyMd", value: string) {
    setTemplates((prev) => ({
      ...prev,
      [type]: { ...(prev[type] ?? { id: "", type, ...DEFAULT_TEMPLATES[type] }), [field]: value },
    }));
  }

  async function saveTemplate(type: TemplateType) {
    const template = templates[type];
    if (!template) return;
    setSaving(type);
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/outreach-templates`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, subject: template.subject, bodyMd: template.bodyMd }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(null);
    if (!res.ok) {
      setError(data.message || "Failed to save template");
      return;
    }
    setMessage("Template saved");
  }

  const types = Object.keys(DEFAULT_TEMPLATES) as TemplateType[];
  const active = templates[activeType];

  return (
    <div className="mx-auto w-full max-w-7xl">
      <div className="page-head">
        <h1>Outreach templates</h1>
        <p className="muted">The emails Pratibha sends candidates at each stage. Edit and save each one independently.</p>
      </div>

      {error && (
        <div className="mb-5 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
      {message && (
        <div className="mb-5 rounded-lg border border-[var(--success-border)] bg-[var(--success-soft)] px-4 py-3 text-sm text-[var(--success)]">
          {message}
        </div>
      )}

      {/* Tab switcher — replaces three long stacked forms with one form at a
          time, so editing one template no longer means scrolling past the
          other two. All three still live in `templates` state regardless of
          which tab is showing. */}
      <div className="mb-5 flex gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1.5">
        {types.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => setActiveType(type)}
            className={[
              "flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition",
              activeType === type
                ? "bg-[var(--accent)] text-white shadow-[var(--shadow-sm)]"
                : "text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]",
            ].join(" ")}
          >
            {TYPE_META[type].label}
          </button>
        ))}
      </div>

      {active && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)] sm:p-7">
          <p className="mb-5 text-sm text-[var(--text-muted)]">{TYPE_META[activeType].hint}</p>

          <div className="mb-5">
            <label htmlFor={`${activeType}-subject`} className="mb-1.5 block text-sm font-semibold text-[var(--text)]">
              Subject
            </label>
            <input
              id={`${activeType}-subject`}
              type="text"
              value={active.subject}
              onChange={(e) => updateTemplate(activeType, "subject", e.target.value)}
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--text)] outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent)]/15"
            />
          </div>

          <div className="mb-4">
            <label htmlFor={`${activeType}-body`} className="mb-1.5 block text-sm font-semibold text-[var(--text)]">
              Body (Markdown)
            </label>
            <textarea
              id={`${activeType}-body`}
              value={active.bodyMd}
              onChange={(e) => updateTemplate(activeType, "bodyMd", e.target.value)}
              rows={12}
              className="w-full resize-y rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-3 font-mono text-[13px] leading-relaxed text-[var(--text)] outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent)]/15"
            />
          </div>

          <div className="mb-6 flex flex-wrap gap-1.5">
            {PLACEHOLDER_TOKENS.map((token) => (
              <code
                key={token}
                className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text-muted)]"
              >
                {token}
              </code>
            ))}
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] pt-5">
            <button
              onClick={() => saveTemplate(activeType)}
              disabled={saving === activeType}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving === activeType && (
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
                </svg>
              )}
              {saving === activeType ? "Saving..." : "Save template"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}