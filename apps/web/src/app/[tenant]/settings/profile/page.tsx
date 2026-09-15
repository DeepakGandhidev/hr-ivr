"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  createdAt: string | null;
  lastSeenAt: string | null;
  userAgent: string | null;
  ip: string | null;
}

/**
 * The signed-in person's own settings.
 *
 * Ordered by how often it is needed and how much damage it can do: the harmless
 * things first, credentials next, and the security tools last. Password, email
 * and sessions are visually separated from the profile fields because they are
 * not the same kind of action — one is a preference, the others are a change to
 * how you get in.
 */
export default function PersonalProfilePage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;

  const [me, setMe] = useState<Me | null>(null);
  const [timezones, setTimezones] = useState<string[]>([]);
  const [types, setTypes] = useState<NotificationType[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/${tenant}/profile`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Could not load your profile");
      return;
    }
    setMe(data.user);
    setTimezones(data.timezones ?? []);
    setTypes(data.notificationTypes ?? []);

    const sres = await fetch(`/api/${tenant}/profile/sessions`);
    if (sres.ok) {
      const sdata = await sres.json().catch(() => ({}));
      setSessions(sdata.sessions ?? []);
    }
  }, [tenant]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(body: Record<string, unknown>, note: string) {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not save");
        return;
      }
      setMe(data.user);
      setMessage(note);
    } finally {
      setSaving(false);
    }
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
      await patch({ photoAssetId: data.asset.id }, "Photo updated.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/profile/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not change your password");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setMessage(
        data.otherSessionsEnded
          ? "Password changed. Every other signed-in device has been signed out."
          : "Password changed, but other sessions could not be ended — sign out everywhere below."
      );
      await load();
    } finally {
      setPwBusy(false);
    }
  }

  async function changeEmail(e: React.FormEvent) {
    e.preventDefault();
    setEmailBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/profile/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail, currentPassword: emailPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not change your email");
        return;
      }
      setNewEmail("");
      setEmailPassword("");
      setMessage(data.message);
    } finally {
      setEmailBusy(false);
    }
  }

  async function signOutEverywhere() {
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/profile/sessions`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Could not sign out the other sessions");
      return;
    }
    setMessage("Signed out everywhere else.");
    await load();
  }

  if (!me) {
    return (
      <div className="card empty">
        {error ? <p className="notice notice-error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const prefs = me.notificationPrefs ?? {};

  return (
    <div className="dash" style={{ maxWidth: 760 }}>
      <div className="page-head">
        <h1>My profile</h1>
        <p className="subtle" style={{ margin: 0 }}>
          Your own account. Company details are in{" "}
          <a href={`/${tenant}/settings/company`}>Company profile</a>.
        </p>
      </div>

      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}

      <div className="card stack" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>You</h3>

        <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
          <div className="avatar-preview">
            {me.photoAssetId ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/${tenant}/assets/${me.photoAssetId}`} alt="" />
            ) : (
              <span>{(me.name ?? me.email).slice(0, 1).toUpperCase()}</span>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadPhoto(file);
              }}
            />
            <p className="subtle field-hint">PNG, JPG or WebP, up to 2 MB.</p>
          </div>
        </div>

        <label>
          <span>Name</span>
          <input
            value={me.name ?? ""}
            onChange={(e) => setMe({ ...me, name: e.target.value })}
            onBlur={() => patch({ name: me.name || null }, "Name saved.")}
          />
        </label>

        <label>
          <span>Timezone</span>
          <select
            value={me.timezone ?? ""}
            onChange={(e) => {
              const timezone = e.target.value || null;
              setMe({ ...me, timezone });
              patch({ timezone }, "Timezone saved.");
            }}
          >
            <option value="">Not set</option>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
            ))}
          </select>
          <span className="subtle field-hint">
            Only changes how dates are shown to you. Nothing is stored differently.
          </span>
        </label>
      </div>

      <div className="card stack" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>Emails you receive</h3>
        <p className="subtle" style={{ margin: 0 }}>
          Turning one off stops that email only. Anything not listed here — a
          password change, a security alert — is always sent.
        </p>

        {types.map((type) => {
          // Absent means on, so a notification added later reaches people
          // rather than arriving silently disabled.
          const on = prefs[type.key] !== false;
          return (
            <label key={type.key} className="pref-row">
              <input
                type="checkbox"
                checked={on}
                disabled={saving}
                onChange={(e) =>
                  patch(
                    { notificationPrefs: { ...prefs, [type.key]: e.target.checked } },
                    "Preferences saved."
                  )
                }
              />
              <span>
                <strong>{type.label}</strong>
                <span className="subtle" style={{ display: "block" }}>{type.description}</span>
              </span>
            </label>
          );
        })}
      </div>

      <form onSubmit={changePassword} className="card stack" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>Password</h3>
        <p className="subtle" style={{ margin: 0 }}>
          Changing it signs out every other device. This one stays signed in.
        </p>

        <label>
          <span>Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </label>

        <label>
          <span>New password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={10}
            required
          />
          <span className="subtle field-hint">At least 10 characters.</span>
        </label>

        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="submit" className="btn btn-primary" disabled={pwBusy}>
            {pwBusy ? "Changing…" : "Change password"}
          </button>
        </div>
      </form>

      <form onSubmit={changeEmail} className="card stack" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>Email address</h3>
        <p className="subtle" style={{ margin: 0 }}>
          You sign in with <strong>{me.email}</strong>. A new address has to be
          confirmed before it takes effect — the current one keeps working until
          then.
        </p>

        <label>
          <span>New email address</span>
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            required
          />
        </label>

        <label>
          <span>Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={emailPassword}
            onChange={(e) => setEmailPassword(e.target.value)}
            required
          />
        </label>

        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="submit" className="btn" disabled={emailBusy}>
            {emailBusy ? "Sending…" : "Send confirmation"}
          </button>
        </div>
      </form>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Where you are signed in</h3>
          <button className="sm ghost" style={{ marginLeft: "auto" }} onClick={signOutEverywhere}>
            Sign out everywhere else
          </button>
        </div>

        {sessions.length === 0 ? (
          <p className="subtle" style={{ margin: 0 }}>No other sessions found.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Device</th><th>IP</th><th>Last seen</th></tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    {/* Shown as sent. Parsing it into "Chrome on macOS" guesses,
                        and a wrong guess is worse than a raw string for someone
                        deciding whether a session is theirs. */}
                    <td style={{ maxWidth: 320, wordBreak: "break-word" }}>
                      {s.userAgent ?? "Unknown device"}
                    </td>
                    <td>{s.ip ?? "—"}</td>
                    <td>{s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Two-factor authentication</h3>
        <p className="subtle" style={{ marginTop: 0 }}>
          Not enabled yet. When it is, it will be handled by the authentication
          provider that already guards sign-in, so that it actually gates a
          login rather than only these screens.
        </p>
      </div>
    </div>
  );
}
