"use client";

import { useEffect, useState } from "react";

interface TeamMember {
  id: string;
  email: string;
  name?: string | null;
  role: string;
}

const ROLE_META: Record<string, { label: string; gradient: string; chip: string }> = {
  owner: {
    label: "Owner",
    gradient: "from-[var(--accent)] to-[var(--accent-hover)]",
    chip: "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]",
  },
  admin: {
    label: "Admin",
    gradient: "from-[var(--warning)] to-[var(--warning)]/70",
    chip: "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]",
  },
  reviewer: {
    label: "Reviewer",
    gradient: "from-[var(--success)] to-[var(--success)]/70",
    chip: "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]",
  },
  viewer: {
    label: "Viewer",
    gradient: "from-[var(--text-muted)] to-[var(--text-subtle)]",
    chip: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]",
  },
};

const roleMeta = (role: string) => ROLE_META[role] ?? ROLE_META.viewer;

function PeopleIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 19c.7-3 2.9-4.5 5.5-4.5s4.8 1.5 5.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M15.5 6.2c1.3.3 2.2 1.4 2.2 2.8 0 1.4-.9 2.5-2.2 2.8M17.5 14.6c1.9.5 3.2 1.9 3.7 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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

export default function TeamPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/${tenant}/team`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setMembers(data.users ?? []))
      .catch(() => setError("Failed to load team"));
  }, [tenant]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/team`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role }),
    });
    const data = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) {
      setError(data.message || "Failed to invite user");
      return;
    }
    setMessage("Invitation sent");
    setEmail("");
    setRole("viewer");
    setMembers((prev) => [...prev, data.user ?? { id: email, email, role }]);
  }

  const inputCls =
    "w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--text)] outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent)]/15";
  const labelCls = "mb-1.5 block text-sm font-semibold text-[var(--text)]";
  const cardCls = "rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)] sm:p-6";

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center gap-3">
        <div className="grid h-11 w-11 flex-none place-items-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white shadow-lg shadow-[var(--accent)]/25">
          <PeopleIcon />
        </div>
        <h1 className="!mb-0">Team</h1>
      </div>
      <p className="muted mb-6">Invite teammates and control what they can see and change.</p>

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

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_360px]">
        {/* Members list takes the flexible left column so it's the visual
            anchor of the page; invite form sits in a fixed sidebar, the same
            split used on the other settings pages. */}
        <div className={cardCls}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-base font-semibold text-[var(--text)]">Members</h3>
            <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--text-muted)]">
              {members.length}
            </span>
          </div>

          {members.length === 0 ? (
            <div className="flex flex-col items-center rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] py-12 text-center">
              <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white">
                <PeopleIcon className="h-5 w-5" />
              </div>
              <p className="text-sm text-[var(--text-muted)]">No team members yet.</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {members.map((member) => {
                const meta = roleMeta(member.role);
                const initial = (member.name || member.email).trim().charAt(0).toUpperCase() || "?";
                return (
                  <li
                    key={member.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 transition hover:border-[var(--accent-border)]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        className={`grid h-9 w-9 flex-none place-items-center rounded-full bg-gradient-to-br text-sm font-bold text-white ${meta.gradient}`}
                      >
                        {initial}
                      </div>
                      <div className="min-w-0">
                        {member.name && (
                          <div className="truncate text-sm font-semibold text-[var(--text)]">{member.name}</div>
                        )}
                        <div className="truncate text-sm text-[var(--text-muted)]">{member.email}</div>
                      </div>
                    </div>
                    <span className={`flex-none rounded-full border px-2.5 py-1 text-xs font-semibold ${meta.chip}`}>
                      {meta.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className={`${cardCls} xl:sticky xl:top-6 xl:self-start`}>
          <h3 className="mb-4 text-base font-semibold text-[var(--text)]">Invite user</h3>
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label htmlFor="email" className={labelCls}>
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="teammate@company.com"
                className={inputCls}
              />
            </div>
            <div className="mb-5">
              <label htmlFor="role" className={labelCls}>
                Role
              </label>
              <select id="role" value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
                <option value="admin">Admin</option>
                <option value="reviewer">Reviewer</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[var(--accent-hover)] px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-[var(--accent)]/25 transition hover:shadow-lg hover:shadow-[var(--accent)]/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading && (
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
                </svg>
              )}
              {loading ? "Inviting..." : "Invite"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}