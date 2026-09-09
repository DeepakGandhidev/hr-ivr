"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";

interface TenantNavProps {
  tenant: string;
}

/**
 * The sidebar marks the current page with aria-current, which both drives the
 * active style and tells a screen reader where it is. Without it every link
 * looked identical and the app gave no sense of place.
 */
export function TenantNav({ tenant }: TenantNavProps) {
  const pathname = usePathname() ?? "";

  const groups = [
    {
      label: "Hiring",
      links: [
        { href: `/${tenant}`, label: "Overview", exact: true },
        { href: `/${tenant}/jobs`, label: "Jobs" },
        { href: `/${tenant}/pipeline`, label: "Pipeline" },
        { href: `/${tenant}/calls`, label: "Calls" },
      ],
    },
    {
      label: "Settings",
      links: [
        { href: `/${tenant}/settings/email`, label: "Email" },
        { href: `/${tenant}/settings/team`, label: "Team" },
        { href: `/${tenant}/settings/templates`, label: "Templates" },
        { href: `/${tenant}/settings/call-windows`, label: "Call windows" },
        { href: `/${tenant}/settings/protocols`, label: "Interview" },
      ],
    },
  ];

  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav className="sidebar">
      <Link href={`/${tenant}`} className="brand">
        <span className="brand-mark">P</span>
        Pratibha
      </Link>

      {groups.map((group) => (
        <div key={group.label}>
          <div className="nav-section">{group.label}</div>
          {group.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="nav-link"
              aria-current={isActive(link.href, link.exact) ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}
        </div>
      ))}

      <QuotaMeters tenant={tenant} />

      <ThemeToggle />
    </nav>
  );
}

/**
 * Interviews and screenings used this month, against the plan's ceiling.
 *
 * Renders nothing at all until the numbers arrive, and nothing ever on an
 * unlimited plan: an empty progress bar that can never fill is noise in a
 * sidebar someone looks at all day.
 */
function QuotaMeters({ tenant }: { tenant: string }) {
  const [usage, setUsage] = useState<{
    meter: { interviewsUsed: number; screeningsUsed: number };
    limits: { interviews: number | null; screenings: number | null };
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/${tenant}/usage`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.meter) setUsage(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tenant]);

  if (!usage) return null;

  const rows = [
    { label: "Interviews this month", used: usage.meter.interviewsUsed, limit: usage.limits.interviews },
    { label: "CV screenings", used: usage.meter.screeningsUsed, limit: usage.limits.screenings },
  ].filter((r) => r.limit !== null);

  if (rows.length === 0) return null;

  return (
    <div className="usage-meter" style={{ marginTop: "auto", paddingTop: 16 }}>
      {rows.map((r) => (
        <div key={r.label}>
          {r.label}
          <span className="val">{r.used} / {r.limit}</span>
          <div className="track">
            <div className="fill" style={{ width: `${Math.min(100, (r.used / r.limit!) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
