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

export default function TemplatesPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const [templates, setTemplates] = useState<Partial<Record<TemplateType, OutreachTemplate>>>({});
  const [saving, setSaving] = useState<TemplateType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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

  return (
    <div>
      <div className="page-head"><h1>Outreach templates</h1></div>
      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}
      {(Object.keys(DEFAULT_TEMPLATES) as TemplateType[]).map((type) => (
        <fieldset key={type} style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 16, marginBottom: 16 }}>
          <legend style={{ textTransform: "capitalize", padding: "0 8px" }}>{type.replace(/_/g, " ")}</legend>
          <div style={{ marginBottom: 12 }}>
            <label htmlFor={`${type}-subject`}>Subject</label>
            <input
              id={`${type}-subject`}
              type="text"
              value={templates[type]?.subject ?? DEFAULT_TEMPLATES[type].subject}
              onChange={(e) => updateTemplate(type, "subject", e.target.value)}
              
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label htmlFor={`${type}-body`}>Body (Markdown)</label>
            <textarea
              id={`${type}-body`}
              value={templates[type]?.bodyMd ?? DEFAULT_TEMPLATES[type].bodyMd}
              onChange={(e) => updateTemplate(type, "bodyMd", e.target.value)}
              rows={8}
              style={{ width: "100%", padding: 8, marginTop: 4, fontFamily: "inherit" }}
            />
          </div>
          <button onClick={() => saveTemplate(type)} disabled={saving === type} className="primary">
            {saving === type ? "Saving..." : "Save template"}
          </button>
        </fieldset>
      ))}
    </div>
  );
}
