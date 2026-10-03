"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { copyText, useToast } from "@/components/Toast";
import { COMPANY_COPY, gstinMismatchWarning, gstinValidLine } from "@/lib/company-copy";

interface Profile {
  legalName: string | null;
  addressLine: string | null;
  city: string | null;
  pinCode: string | null;
  billingState: string | null;
  gstin: string | null;
  description: string | null;
  logoAssetId: string | null;
}

interface State {
  code: string;
  name: string;
}

interface Limits {
  legalName: number;
  addressLine: number;
  city: number;
  description: number;
  logoBytes: number;
}

const EMPTY: Profile = {
  legalName: null,
  addressLine: null,
  city: null,
  pinCode: null,
  billingState: null,
  gstin: null,
  description: null,
  logoAssetId: null,
};

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const PIN_PATTERN = /^[1-9][0-9]{5}$/;

/**
 * The company's own details — the entity, not the voice.
 *
 * Two cards, as the artboard has them: what candidates see (logo, description,
 * the careers page link) and what invoices print (legal name, GSTIN, the
 * structured address and the state that decides the tax split). One save for
 * both. The name here goes on invoices; the name Pratibha says out loud is in
 * Interview settings, and each side says so.
 */
export default function CompanyProfilePage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const toast = useToast();

  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [states, setStates] = useState<State[]>([]);
  const [limits, setLimits] = useState<Limits>({ legalName: 200, addressLine: 300, city: 100, description: 600, logoBytes: 2 * 1024 * 1024 });
  const [workspaceName, setWorkspaceName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [careersUrl, setCareersUrl] = useState("");
  const [stateText, setStateText] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/${tenant}/company-profile`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Could not load the company profile");
      return;
    }
    const p = { ...EMPTY, ...data.profile };
    setProfile(p);
    setStateText(p.billingState ?? "");
    setStates(data.states ?? []);
    if (data.limits) setLimits(data.limits);
    setWorkspaceName(data.workspaceName ?? "");
    setCareersUrl(`${window.location.origin}/careers/${data.slug ?? tenant}`);
    setLoaded(true);
  }, [tenant]);

  useEffect(() => {
    load();
  }, [load]);

  function set<K extends keyof Profile>(key: K, value: Profile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
  }

  // --- GSTIN, live -----------------------------------------------------------
  const gstin = (profile.gstin ?? "").trim().toUpperCase();
  const gstinFormatOk = gstin === "" || GSTIN_PATTERN.test(gstin);
  const gstinState = gstin.length >= 2 ? states.find((s) => s.code === gstin.slice(0, 2)) ?? null : null;
  const selectedState = states.find((s) => s.name === profile.billingState) ?? null;
  const gstinMismatch = Boolean(gstin && gstinFormatOk && gstinState && selectedState && gstinState.code !== selectedState.code);

  // --- other field checks ------------------------------------------------------
  const pin = (profile.pinCode ?? "").trim();
  const pinOk = pin === "" || PIN_PATTERN.test(pin);
  const stateOk = stateText.trim() === "" || Boolean(states.find((s) => s.name === stateText.trim()));
  const descLength = (profile.description ?? "").length;
  const descOk = descLength <= limits.description;
  const canSave = gstinFormatOk && pinOk && stateOk && descOk && !saving;

  const stateOptions = useMemo(() => states.map((s) => ({ value: s.name, label: `${s.name} (${s.code})` })), [states]);

  async function uploadLogo(file: File) {
    if (file.size > limits.logoBytes) {
      setError(`That file is over ${(limits.logoBytes / (1024 * 1024)).toFixed(0)} MB.`);
      return;
    }
    setUploading(true);
    setError(null);
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
      toast.show("Logo updated");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeLogo() {
    setUploading(true);
    setError(null);
    try {
      const res = await fetch(`/api/${tenant}/company-profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logoAssetId: null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not remove the logo");
        return;
      }
      set("logoAssetId", null);
      toast.show("Logo removed. Candidates now see your company name.");
    } finally {
      setUploading(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/${tenant}/company-profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legalName: profile.legalName?.trim() || null,
          addressLine: profile.addressLine?.trim() || null,
          city: profile.city?.trim() || null,
          pinCode: pin || null,
          billingState: stateText.trim() || null,
          gstin: gstin || null,
          description: profile.description?.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not save the company profile");
        return;
      }
      const p = { ...EMPTY, ...data.profile };
      setProfile(p);
      setStateText(p.billingState ?? "");
      toast.show(data.warning ? "Saved, but the GSTIN and state disagree" : "Company profile saved");
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

  const fallbackName = profile.legalName?.trim() || workspaceName;

  return (
    <form className="jm" onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 1040 }}>
      <div>
        <h1>Company profile</h1>
        <p className="cp-sub">Your company as it appears to candidates and on invoices.</p>
      </div>

      {error && <div className="notice notice-error" role="alert">{error}</div>}

      {/* ---- What candidates see ------------------------------------------ */}
      <section className="cp-card" aria-labelledby="cp-candidates">
        <div className="cp-card-title" id="cp-candidates">What candidates see</div>
        <div className="cp-logo-row">
          <div className="cp-logo">
            <div className="cp-logo-tile">
              {profile.logoAssetId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/${tenant}/assets/${profile.logoAssetId}`} alt={`${fallbackName} logo`} />
              ) : (
                // The same fallback candidates get: the company name as text.
                <span className="cp-logo-fallback">{fallbackName}</span>
              )}
            </div>
            <div className="cp-logo-links">
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}>
                {uploading ? "Working…" : "Upload logo"}
              </button>
              {profile.logoAssetId && (
                <button type="button" className="quiet" onClick={removeLogo} disabled={uploading}>Remove</button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              hidden
              aria-label="Upload logo"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadLogo(file);
              }}
            />
          </div>
          <div style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div className="cp-help" style={{ fontSize: 12.5, marginTop: 0 }}>{COMPANY_COPY.logoHelper}</div>
            <div className="cp-field">
              <label htmlFor="cp-desc">Company description</label>
              <textarea
                id="cp-desc"
                className={descOk ? undefined : "invalid"}
                value={profile.description ?? ""}
                onChange={(e) => set("description", e.target.value)}
                aria-describedby="cp-desc-help"
              />
              <div className="cp-help" id="cp-desc-help">
                <span className={`cp-count${descOk ? "" : " bad"}`} aria-live="polite">
                  {descLength} / {limits.description}
                </span>
                {COMPANY_COPY.descriptionHelper}
              </div>
            </div>
          </div>
        </div>
        <div className="cp-careers">
          <span className="cp-careers-label" id="cp-careers-label">Your careers page</span>
          <span className="cp-careers-url" title={careersUrl} aria-labelledby="cp-careers-label">{careersUrl}</span>
          <button
            type="button"
            className="btn-line sm"
            onClick={async () => toast.show((await copyText(careersUrl)) ? "Link copied" : "Could not copy the link")}
          >
            Copy link
          </button>
          <a href={careersUrl} target="_blank" rel="noopener noreferrer" className="btn-line sm" style={{ textDecoration: "none" }}>
            Preview <span aria-hidden="true">↗</span>
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </div>
      </section>

      {/* ---- Invoice details --------------------------------------------- */}
      <section className="cp-card" aria-labelledby="cp-invoice" style={{ gap: 14 }}>
        <div>
          <div className="cp-card-title" id="cp-invoice">Invoice details</div>
          <div className="cp-card-sub">{COMPANY_COPY.invoiceSubline}</div>
        </div>

        <div className="cp-grid-2">
          <div className="cp-field">
            <label htmlFor="cp-lname">Legal company name</label>
            <input
              id="cp-lname"
              type="text"
              value={profile.legalName ?? ""}
              maxLength={limits.legalName}
              onChange={(e) => set("legalName", e.target.value)}
              placeholder="Promonkey Technologies LLP"
              autoComplete="organization"
            />
            <div className="cp-help">
              The registered entity on invoices and contracts. What Pratibha says on calls is{" "}
              <Link href={`/${tenant}/settings/protocols`} style={{ fontWeight: 600 }}>Hiring under</Link>, in Interview settings.
            </div>
          </div>

          <div className="cp-field">
            <label htmlFor="cp-gstin">GSTIN</label>
            <input
              id="cp-gstin"
              type="text"
              className={`mono${gstinFormatOk ? "" : " invalid"}`}
              value={profile.gstin ?? ""}
              maxLength={15}
              onChange={(e) => set("gstin", e.target.value.toUpperCase().replace(/\s/g, ""))}
              placeholder="07AASFP3808P2ZF"
              aria-describedby="cp-gstin-help"
              aria-invalid={!gstinFormatOk}
              spellCheck={false}
            />
            <div id="cp-gstin-help" aria-live="polite">
              {gstin === "" ? (
                <div className="cp-help">{COMPANY_COPY.gstinEmptyHelper}</div>
              ) : !gstinFormatOk ? (
                <div className="cp-help bad">
                  {gstin.length < 15
                    ? `${gstin.length} of 15 characters. A GSTIN is 15 characters, like 07AASFP3808P2ZF.`
                    : "That is not a valid GSTIN format. Check it against your registration certificate."}
                </div>
              ) : gstinMismatch ? (
                <div className="cp-warning" role="alert">
                  {gstinMismatchWarning(gstin.slice(0, 2), gstinState!.name, selectedState!.name)}
                </div>
              ) : gstinState && selectedState ? (
                <div className="cp-help ok">{gstinValidLine(gstinState.name, gstinState.code)}</div>
              ) : (
                <div className="cp-help ok">
                  Valid format{gstinState ? ` · ${gstinState.name} (${gstinState.code})` : ""}. Choose your state below to check it matches.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="cp-field">
          <label htmlFor="cp-addr">Registered address</label>
          <input
            id="cp-addr"
            type="text"
            value={profile.addressLine ?? ""}
            maxLength={limits.addressLine}
            onChange={(e) => set("addressLine", e.target.value)}
            placeholder="Building, street and area"
            autoComplete="street-address"
          />
        </div>

        <div className="cp-grid-3">
          <div className="cp-field">
            <label htmlFor="cp-city">City</label>
            <input
              id="cp-city"
              type="text"
              value={profile.city ?? ""}
              maxLength={limits.city}
              onChange={(e) => set("city", e.target.value)}
              autoComplete="address-level2"
            />
          </div>
          <div className="cp-field">
            <label htmlFor="cp-pin">PIN code</label>
            <input
              id="cp-pin"
              type="text"
              inputMode="numeric"
              className={pinOk ? undefined : "invalid"}
              value={profile.pinCode ?? ""}
              maxLength={6}
              onChange={(e) => set("pinCode", e.target.value.replace(/\D/g, ""))}
              aria-invalid={!pinOk}
              aria-describedby="cp-pin-help"
              autoComplete="postal-code"
            />
            {!pinOk && <div className="cp-help bad" id="cp-pin-help">A PIN code is six digits.</div>}
          </div>
          <div className="cp-field">
            <label htmlFor="cp-state">State</label>
            <input
              id="cp-state"
              type="text"
              list="cp-states"
              className={stateOk ? undefined : "invalid"}
              value={stateText}
              onChange={(e) => {
                const raw = e.target.value;
                // Choosing "Delhi (07)" from the list stores the state's name.
                const picked = states.find((s) => raw === `${s.name} (${s.code})`);
                const text = picked ? picked.name : raw;
                setStateText(text);
                set("billingState", states.find((s) => s.name === text.trim())?.name ?? null);
              }}
              placeholder="Type to search"
              aria-describedby="cp-state-help"
              aria-invalid={!stateOk}
              autoComplete="off"
            />
            <datalist id="cp-states">
              {stateOptions.map((o) => <option key={o.value} value={o.label} />)}
            </datalist>
            <div className={`cp-help${stateOk ? "" : " bad"}`} id="cp-state-help">
              {stateOk ? COMPANY_COPY.stateHelper : "Choose a state or union territory from the list."}
            </div>
          </div>
        </div>
      </section>

      <div className="cp-foot">
        <div className="cp-foot-text">
          {COMPANY_COPY.footerBefore}
          <Link href={`/${tenant}/settings/subscription`} style={{ fontWeight: 600 }}>Subscription</Link>.
        </div>
        <div className="jm-spacer" />
        <button type="submit" className="btn-ink cp-save" disabled={!canSave}>
          {saving ? "Saving…" : "Save company profile"}
        </button>
      </div>
      {toast.node}
    </form>
  );
}
