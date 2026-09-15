"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface Profile {
  legalName: string | null;
  billingAddress: string | null;
  billingState: string | null;
  gstin: string | null;
  description: string | null;
  logoAssetId: string | null;
}

interface State {
  code: string;
  name: string;
}

const EMPTY: Profile = {
  legalName: null,
  billingAddress: null,
  billingState: null,
  gstin: null,
  description: null,
  logoAssetId: null,
};

/**
 * The company's own details — the entity, not the voice.
 *
 * Deliberately separate from Interview settings, and each side says so: the
 * name here goes on invoices, the name there is what Pratibha says out loud.
 * Someone editing one expecting the other to change is the specific mistake
 * these helper lines exist to prevent.
 */
export default function CompanyProfilePage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;

  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [states, setStates] = useState<State[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/${tenant}/company-profile`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Could not load the company profile");
      return;
    }
    setProfile({ ...EMPTY, ...data.profile });
    setStates(data.states ?? []);
    setWorkspaceName(data.workspaceName ?? "");
    setLoaded(true);
  }, [tenant]);

  useEffect(() => {
    load();
  }, [load]);

  function set<K extends keyof Profile>(key: K, value: Profile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
  }

  async function uploadLogo(file: File) {
    setUploading(true);
    setError(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", "company_logo");

      const res = await fetch(`/api/${tenant}/assets`, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not upload that logo");
        return;
      }

      // Pinned immediately so the preview is of the saved logo, not of a local
      // object URL that would disagree with what candidates actually see.
      const patch = await fetch(`/api/${tenant}/company-profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logoAssetId: data.asset.id }),
      });
      if (!patch.ok) {
        const body = await patch.json().catch(() => ({}));
        setError(body.message || "Logo uploaded but could not be saved");
        return;
      }

      set("logoAssetId", data.asset.id);
      setMessage("Logo updated.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/company-profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legalName: profile.legalName || null,
          billingAddress: profile.billingAddress || null,
          billingState: profile.billingState || null,
          gstin: profile.gstin || null,
          description: profile.description || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not save the company profile");
        return;
      }
      setProfile({ ...EMPTY, ...data.profile });
      setMessage("Company profile saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return (
      <div className="card empty">
        {error ? <p className="notice notice-error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  return (
    <div className="dash" style={{ maxWidth: 760 }}>
      <div className="page-head">
        <h1>Company profile</h1>
        <p className="subtle" style={{ margin: 0 }}>
          Your company as it appears to candidates and on invoices.
        </p>
      </div>

      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Logo</h3>
        <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
          <div className="logo-preview">
            {profile.logoAssetId ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/${tenant}/assets/${profile.logoAssetId}`}
                alt="Company logo"
              />
            ) : (
              <span className="subtle">No logo</span>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadLogo(file);
              }}
            />
            <p className="subtle field-hint">
              PNG, JPG, SVG or WebP, up to 2 MB. Used on your careers page and in
              candidate emails.
            </p>
            {uploading && <p className="subtle">Uploading…</p>}
          </div>
        </div>
      </div>

      <form onSubmit={save} className="card stack">
        <label>
          <span>Legal company name</span>
          <input
            value={profile.legalName ?? ""}
            onChange={(e) => set("legalName", e.target.value)}
            placeholder="Acme Technologies Private Limited"
          />
          <span className="subtle field-hint">
            The registered entity, used on invoices and contracts. This is not
            what Pratibha says on calls — that is{" "}
            <Link href={`/${tenant}/settings/protocols`}>Hiring under</Link> in
            Interview settings
            {workspaceName ? `, currently “${workspaceName}”` : ""}.
          </span>
        </label>

        <label>
          <span>Registered / billing address</span>
          <textarea
            rows={4}
            value={profile.billingAddress ?? ""}
            onChange={(e) => set("billingAddress", e.target.value)}
          />
        </label>

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label>
            <span>State</span>
            <select
              value={profile.billingState ?? ""}
              onChange={(e) => set("billingState", e.target.value || null)}
            >
              <option value="">Select a state</option>
              {states.map((s) => (
                <option key={s.code} value={s.name}>{s.name}</option>
              ))}
            </select>
            <span className="subtle field-hint">
              Decides whether invoices charge CGST + SGST or IGST.
            </span>
          </label>

          <label>
            <span>GSTIN</span>
            <input
              value={profile.gstin ?? ""}
              onChange={(e) => set("gstin", e.target.value.toUpperCase())}
              placeholder="27AAPFU0939F1ZV"
              maxLength={15}
            />
            <span className="subtle field-hint">
              15 characters. Leave blank if you are not registered.
            </span>
          </label>
        </div>

        <label>
          <span>Company description</span>
          <textarea
            rows={5}
            value={profile.description ?? ""}
            onChange={(e) => set("description", e.target.value)}
          />
          <span className="subtle field-hint">
            Shown on your hosted careers page, above the open roles.
          </span>
        </label>

        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Save company profile"}
          </button>
        </div>
      </form>
    </div>
  );
}
