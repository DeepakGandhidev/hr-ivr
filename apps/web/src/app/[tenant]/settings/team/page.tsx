"use client";

import { useEffect, useState } from "react";

interface TeamMember {
  id: string;
  email: string;
  name?: string | null;
  role: string;
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

  return (
    <div>
      <div className="page-head"><h1>Team</h1></div>
      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}

      <form onSubmit={handleSubmit} className="card" style={{ marginBottom: 16 }}>
        <h3>Invite user</h3>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="role">Role</label>
          <select
            id="role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            
          >
            <option value="admin">Admin</option>
            <option value="reviewer">Reviewer</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
        <button type="submit" disabled={loading} className="primary">
          {loading ? "Inviting..." : "Invite"}
        </button>
      </form>

      <h3>Members</h3>
      {members.length === 0 ? (
        <p>No team members yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {members.map((member) => (
            <li key={member.id} className="card" style={{ marginBottom: 8 }}>
              <strong>{member.email}</strong>
              <span style={{ marginLeft: 12, textTransform: "capitalize", color: "var(--text-muted)" }}>{member.role}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
