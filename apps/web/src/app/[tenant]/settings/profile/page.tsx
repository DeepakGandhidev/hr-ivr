"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { TWO_FACTOR_ENABLED } from "@/lib/features";

interface Me {
  id: string;
  name: string | null;
  email: string;
  role: string;
  timezone: string | null;
  photoAssetId: string | null;
  notificationPrefs: Record<string, boolean> | null;
}

interface NotificationType {
  key: string;
  label: string;
  description: string;
}

interface SessionRow {
  id: string;
  current: boolean;
  device: string;
  place: string | null;
  ip: string | null;
  lastSeenAt: string | null;
}

/** "GD" for Gaurav Dhingra, "HR" for hr@promonkey.tech. */
function initials(name: string | null, email: string) {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}

/** "Today, 2:54 pm" or "24 Sep, 1:36 am", in the person's own timezone. */
function seen(value: string | null, timeZone: string | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  const part = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone, ...opts }).format(d);
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const time = part({ hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?([ap])\.?m\.?/i, " $1m").toLowerCase();
  if (day(d) === day(new Date())) return `Today, ${time}`;
  const date = part({ day: "numeric", month: "short", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) }).replace("Sept", "Sep");
  return `${date}, ${time}`;
}

/**
 * My profile (Batch 5). The person's own account: who they are, which emails
 * they get, how they sign in, and where they are signed in. Company details
 * live in Company profile.
 */
export default function PersonalProfilePage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const router = useRouter();
  const toast = useToast(3200);
  const uid = useId();

  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState("");
  const [tzText, setTzText] = useState("");
  const [timezones, setTimezones] = useState<string[]>([]);
  const [types, setTypes] = useState<NotificationType[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    const r = await fetch(`/api/${tenant}/profile/sessions`, { cache: "no-store" });
    if (r.ok) setSessions((await r.json().catch(() => ({}))).sessions ?? []);
  }, [tenant]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/${tenant}/profile`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Could not load your profile");
      return;
    }
    setMe(data.user);
    setName(data.user.name ?? "");
    setTzText(data.user.timezone ?? "");
    setTimezones(data.timezones ?? []);
    setTypes(data.notificationTypes ?? []);
    const e = await fetch(`/api/${tenant}/profile/email`, { cache: "no-store" });
    if (e.ok) setPendingEmail((await e.json().catch(() => ({}))).pendingEmail ?? null);
    await loadSessions();
  }, [tenant, loadSessions]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>, note: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/${tenant}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not save");
        return false;
      }
      setMe(data.user);
      toast.show(note);
      return true;
    } finally {
      setSaving(false);
    }
  }

  async function saveName() {
    if (!me || (name.trim() || null) === (me.name ?? null)) return;
    // The name shows in the sidebar and on everything they author; refresh
    // the server-rendered parts so it changes there too.
    if (await patch({ name: name.trim() || null }, "Name saved.")) router.refresh();
  }

  async function saveTimezone(value: string) {
    if (!me) return;
    const tz = value.trim();
    if (!tz) {
      if (me.timezone) await patch({ timezone: null }, "Timezone cleared.");
      return;
    }
    const match = timezones.find((t) => t.toLowerCase() === tz.toLowerCase() || t.replace(/_/g, " ").toLowerCase() === tz.toLowerCase());
    if (!match) {
      setError("Choose a timezone from the list.");
      return;
    }
    setTzText(match);
    if (match !== me.timezone) await patch({ timezone: match }, "Timezone saved.");
  }

  async function uploadPhoto(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", "user_photo");
      const res = await fetch(`/api/${tenant}/assets`, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not upload that photo");
        return;
      }
      if (await patch({ photoAssetId: data.asset.id }, "Photo updated.")) router.refresh();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwBusy(true);
    setPwError(null);
    try {
      const res = await fetch(`/api/${tenant}/profile/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPwError(data.message || "Could not change your password");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      toast.show(
        data.otherSessionsEnded
          ? "Password changed. Every other device has been signed out."
          : "Password changed, but other devices could not be signed out. Use Sign out everywhere else."
      );
      await loadSessions();
    } finally {
      setPwBusy(false);
    }
  }

  async function changeEmail(e: React.FormEvent) {
    e.preventDefault();
    setEmailBusy(true);
    setEmailError(null);
    try {
      const res = await fetch(`/api/${tenant}/profile/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail, currentPassword: emailPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEmailError(data.message || "Could not change your email");
        return;
      }
      setPendingEmail(data.pendingEmail ?? newEmail);
      setNewEmail("");
      setEmailPassword("");
    } finally {
      setEmailBusy(false);
    }
  }

  async function pendingAction(method: "PUT" | "DELETE") {
    setEmailBusy(true);
    setEmailError(null);
    try {
      const res = await fetch(`/api/${tenant}/profile/email`, { method });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEmailError(data.message || "That did not work");
        return;
      }
      if (method === "DELETE") {
        setPendingEmail(null);
        toast.show("Email change cancelled. You still sign in with your current address.");
      } else {
        toast.show(`Confirmation sent again to ${data.pendingEmail}.`);
      }
    } finally {
      setEmailBusy(false);
    }
  }

  async function signOut(id?: string, device?: string) {
    setError(null);
    const res = await fetch(`/api/${tenant}/profile/sessions${id ? `?id=${encodeURIComponent(id)}` : ""}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Could not sign that out");
      return;
    }
    toast.show(id ? `Signed out ${device ?? "that device"}.` : "Signed out everywhere else.");
    await loadSessions();
  }

  if (!me) {
    return <div className="jm">{error ? <div className="notice notice-error">{error}</div> : <p className="muted">Loading…</p>}</div>;
  }

  const prefs = me.notificationPrefs ?? {};
  const tz = me.timezone ?? undefined;
  const others = sessions.filter((s) => !s.current).length;

  return (
    <div className="jm mp">
      <div>
        <h1>My profile</h1>
        <p className="muted mp-sub">
          Your own account. Company details are in <a href={`/${tenant}/settings/company`}>Company profile</a>.
        </p>
      </div>

      {error && <div className="notice notice-error" role="alert">{error}</div>}

      <div className="mp-cols">
        <div className="mp-col">
          <section className="mp-card" aria-labelledby={`${uid}-you`}>
            <h2 id={`${uid}-you`} className="mp-title">You</h2>
            <div className="mp-photo">
              <div className="mp-avatar" aria-hidden={!me.photoAssetId}>
                {me.photoAssetId ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/${tenant}/assets/${me.photoAssetId}`} alt="Your photo" />
                ) : (
                  <span>{initials(me.name, me.email)}</span>
                )}
              </div>
              <div className="mp-photo-actions">
                <input
                  ref={fileRef}
                  id={`${uid}-file`}
                  className="visually-hidden"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={uploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadPhoto(file);
                  }}
                />
                <span>
                  <button type="button" className="btn-link link-strong" onClick={() => fileRef.current?.click()} disabled={uploading}>
                    {uploading ? "Uploading…" : "Upload"}
                  </button>
                  {me.photoAssetId && (
                    <>
                      {" · "}
                      <button type="button" className="btn-link" onClick={() => patch({ photoAssetId: null }, "Photo removed.").then((ok) => ok && router.refresh())}>
                        Remove
                      </button>
                    </>
                  )}
                </span>
                <span className="mp-help">PNG, JPG or WebP, up to 2 MB.</span>
              </div>
            </div>
            <div className="mp-field">
              <label htmlFor={`${uid}-name`}>Name</label>
              <input
                id={`${uid}-name`}
                autoComplete="name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
              />
            </div>
            <div className="mp-field">
              <label htmlFor={`${uid}-tz`}>Timezone</label>
              <input
                id={`${uid}-tz`}
                list={`${uid}-tzs`}
                value={tzText.replace(/_/g, " ")}
                placeholder="Search, for example Kolkata"
                autoComplete="off"
                aria-describedby={`${uid}-tz-h`}
                onChange={(e) => setTzText(e.target.value)}
                onBlur={(e) => saveTimezone(e.target.value)}
              />
              <datalist id={`${uid}-tzs`}>
                {timezones.map((t) => (
                  <option key={t} value={t.replace(/_/g, " ")} />
                ))}
              </datalist>
              <p id={`${uid}-tz-h`} className="mp-help">Only changes how dates are shown to you.</p>
            </div>
          </section>

          <section className="mp-card" aria-labelledby={`${uid}-mail`}>
            <div>
              <h2 id={`${uid}-mail`} className="mp-title">Emails you receive</h2>
              <p className="mp-help">Turning one off stops that email only. Password changes and security alerts are always sent.</p>
            </div>
            {types.map((type) => {
              // Absent means on, so a notification added later reaches people.
              const on = prefs[type.key] !== false;
              return (
                <label key={type.key} className="mp-pref">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={saving}
                    onChange={(e) => patch({ notificationPrefs: { ...prefs, [type.key]: e.target.checked } }, "Preferences saved.")}
                  />
                  <span>
                    <span className="mp-pref-label">{type.label}.</span>{" "}
                    <span className="mp-pref-desc">{type.description}</span>
                  </span>
                </label>
              );
            })}
          </section>
        </div>

        <div className="mp-col">
          <form onSubmit={changePassword} className="mp-card" aria-labelledby={`${uid}-pw`}>
            <div>
              <h2 id={`${uid}-pw`} className="mp-title">Password</h2>
              <p className="mp-help">Changing it signs out every other device. This one stays signed in.</p>
            </div>
            {/* Tells the browser whose password this is, so it offers to
                update that saved login instead of filling these boxes. */}
            <input type="text" name="username" autoComplete="username" value={me.email} readOnly hidden />
            <div className="mp-pair">
              <div className="mp-field">
                <label htmlFor={`${uid}-cur`}>Current password</label>
                <input id={`${uid}-cur`} name="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
              </div>
              <div className="mp-field">
                <label htmlFor={`${uid}-new`}>New password</label>
                <input
                  id={`${uid}-new`}
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={10}
                  required
                  aria-describedby={`${uid}-new-h`}
                />
                <p id={`${uid}-new-h`} className="mp-help">At least 10 characters.</p>
              </div>
            </div>
            {pwError && <p className="mp-error" role="alert">{pwError}</p>}
            <div className="mp-actions">
              <button type="submit" className="btn-ink" disabled={pwBusy}>
                {pwBusy ? "Changing…" : "Change password"}
              </button>
            </div>
          </form>

          <form onSubmit={changeEmail} className="mp-card" aria-labelledby={`${uid}-em`} autoComplete="off">
            <div>
              <h2 id={`${uid}-em`} className="mp-title">Email address</h2>
              <p className="mp-help">
                You sign in with <strong>{me.email}</strong>. A new address takes effect after you confirm it; until then the current one keeps working.
              </p>
            </div>
            {pendingEmail && (
              <div className="mp-pending" role="status">
                <span>Waiting for confirmation at {pendingEmail}</span>
                <span className="jm-spacer" />
                <button type="button" className="btn-link link-strong" disabled={emailBusy} onClick={() => pendingAction("PUT")}>
                  Resend
                </button>
                <button type="button" className="btn-link" disabled={emailBusy} onClick={() => pendingAction("DELETE")}>
                  Cancel
                </button>
              </div>
            )}
            <input type="text" name="username" autoComplete="username" value={me.email} readOnly hidden />
            <div className="mp-field">
              <label htmlFor={`${uid}-ne`}>New email address</label>
              <input
                id={`${uid}-ne`}
                name="new-email"
                type="email"
                autoComplete="off"
                placeholder="name@company.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                required
              />
            </div>
            <div className="mp-field">
              <label htmlFor={`${uid}-ep`}>Current password</label>
              <input id={`${uid}-ep`} name="email-current-password" type="password" autoComplete="current-password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} required />
            </div>
            {emailError && <p className="mp-error" role="alert">{emailError}</p>}
            <div className="mp-actions">
              <button type="submit" className="btn-line" disabled={emailBusy}>
                {emailBusy ? "Sending…" : "Send confirmation"}
              </button>
            </div>
          </form>
        </div>
      </div>

      <section className="mp-card" aria-labelledby={`${uid}-ss`}>
        <div className="mp-head">
          <h2 id={`${uid}-ss`} className="mp-title">Where you are signed in</h2>
          <span className="jm-spacer" />
          {others > 0 && (
            <button type="button" className="btn-line sm" onClick={() => signOut()}>
              Sign out everywhere else
            </button>
          )}
        </div>
        {sessions.length === 0 ? (
          <p className="mp-help">No sessions found.</p>
        ) : (
          <table className="rtable mp-sessions">
            <caption className="visually-hidden">Where you are signed in</caption>
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Location and IP</th>
                <th scope="col">Last seen</th>
                <th scope="col"><span className="visually-hidden">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td data-label="Device">
                    <span className="mp-device">{s.device}</span>
                    {s.current && <span className="chip chip-green sm">This device</span>}
                  </td>
                  <td data-label="Location and IP">{[s.place, s.ip].filter(Boolean).join(" · ") || "—"}</td>
                  <td data-label="Last seen">{seen(s.lastSeenAt, tz)}</td>
                  <td className="cell-actions">
                    {!s.current && (
                      <button type="button" className="btn-link link-strong" aria-label={`Sign out ${s.device}${s.place ? ` in ${s.place}` : ""}`} onClick={() => signOut(s.id, s.device)}>
                        Sign out
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mp-help">If you see a device or place you do not recognise, sign it out and change your password.</p>
        <p className="mp-attrib">
          <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a>
        </p>
      </section>

      {TWO_FACTOR_ENABLED && (
        <section className="mp-card" aria-labelledby={`${uid}-2fa`}>
          <h2 id={`${uid}-2fa`} className="mp-title">Two step verification</h2>
          <p className="mp-help">Adds a one time code from an authenticator app when you sign in.</p>
        </section>
      )}

      <section className="mp-card mp-quiet" aria-label="Your data">
        <p>
          Want a copy of your data, or to close your account? Write to <a href="mailto:start@pratibha.tech?subject=Data%20request">start@pratibha.tech</a> with the subject Data request.
        </p>
      </section>

      {toast.node}
    </div>
  );
}
