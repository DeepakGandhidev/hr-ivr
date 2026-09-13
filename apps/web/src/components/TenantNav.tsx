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
 * Minutes used this month, against the plan's ceiling.
 *
 * Minutes lead because minutes are what is billed. The interview figure beside
 * them is an approximation and is labelled as one — customers think in
 * interviews, and dropping the unit they reason in makes the meter unreadable,
 * while presenting the estimate as exact invites the overage argument the meter
 * exists to prevent.
 *
 * Renders nothing until the numbers arrive, and nothing ever on an unlimited
 * plan: a progress bar that can never fill is noise in a sidebar someone looks
 * at all day.
 */
function QuotaMeters({ tenant }: { tenant: string }) {
  const [usage, setUsage] = useState<{
    meter: { interviewMinutesUsed: number; screeningsUsed: number };
    limits: { interviewMinutes: number | null; screenings: number | null };
    minutes: {
      used: number;
      limit: number | null;
      remaining: number | null;
      level: null | "warning" | "exhausted";
      approximateInterviewsRemaining: number | null;
    };
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

  const { minutes } = usage;
  const showMinutes = minutes.limit !== null;
  const screeningLimit = usage.limits.screenings;

  if (!showMinutes && screeningLimit === null) return null;

  return (
    <div className="usage-meter" style={{ marginTop: "auto", paddingTop: 16 }}>
      {showMinutes && (
        <div>
          Interview minutes
          <span className="val">
            {minutes.used} / {minutes.limit}
          </span>
          <div className="track">
            <div
              className={`fill${minutes.level ? ` ${minutes.level}` : ""}`}
              style={{ width: `${Math.min(100, (minutes.used / minutes.limit!) * 100)}%` }}
            />
          </div>
          <div className="usage-note">
            {minutes.remaining} left
            {minutes.approximateInterviewsRemaining !== null &&
              ` · roughly ${minutes.approximateInterviewsRemaining} ${
                minutes.approximateInterviewsRemaining === 1 ? "interview" : "interviews"
              }`}
          </div>
          {minutes.level === "exhausted" ? (
            <div className="usage-warning exhausted">
              Out of minutes. Further interviews bill as overage.
            </div>
          ) : minutes.level === "warning" ? (
            <div className="usage-warning">
              {Math.round((minutes.used / minutes.limit!) * 100)}% of your minutes used.
            </div>
          ) : null}
        </div>
      )}

      {screeningLimit !== null && (
        <div>
          CV screenings
          <span className="val">
            {usage.meter.screeningsUsed} / {screeningLimit}
          </span>
          <div className="track">
            <div
              className="fill"
              style={{
                width: `${Math.min(100, (usage.meter.screeningsUsed / screeningLimit) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
