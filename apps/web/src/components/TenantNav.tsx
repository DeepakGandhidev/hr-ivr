"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";

interface TenantNavProps {
  tenant: string;
  /**
   * Optional live counts shown as a saffron badge next to a nav link, keyed
   * by the link's label — e.g. { Roles: 6, Shortlists: 3 }. Pass real numbers
   * from wherever the page already fetches them; omit a key to hide its badge.
   */
  badges?: Record<string, number>;
}

/**
 * The sidebar marks the current page with aria-current, which both drives the
 * active style and tells a screen reader where it is. Without it every link
 * looked identical and the app gave no sense of place.
 *
 * Styling here is Tailwind utility classes, not the old .sidebar/.nav-link/
 * etc. CSS. The one exception is the `sidebar` class kept on <nav> itself —
 * it does no styling of its own anymore, it only exists so the untouched
 * `.sidebar .theme-toggle` rule in globals.css (still there, unchanged) can
 * keep giving the imported <ThemeToggle /> its dark-on-indigo coloring,
 * since that component's internal markup isn't ours to add Tailwind classes
 * to. Light/Auto/Dark itself is fully intact — this file doesn't touch it.
 *
 * Colors reference the existing --indigo / --saffron design tokens via
 * Tailwind's arbitrary-value syntax (bg-[var(--indigo)]) rather than new
 * hard-coded hex, so this stays wired to the one source of truth in
 * globals.css instead of forking the palette.
 */
export function TenantNav({ tenant, badges }: TenantNavProps) {
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
        // Company first: it is the workspace's own identity, and the section
        // most people look for when they arrive here.
        { href: `/${tenant}/settings/company`, label: "Company profile" },
        // Replaces "Plan & usage": one section, with the meter leading it.
        { href: `/${tenant}/settings/subscription`, label: "Subscription" },
        { href: `/${tenant}/settings/profile`, label: "My profile" },
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
    <nav className="sidebar flex w-60 flex-shrink-0 flex-col gap-1 bg-[var(--indigo)] px-4 pb-4 pt-5 text-white">
      <Link
        href={`/${tenant}`}
        className="mb-1 flex items-center gap-2 pb-4 pl-1 pr-2 text-[15px] font-semibold text-white no-underline hover:no-underline"
      >
        <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[9px] bg-[var(--saffron)] text-[var(--indigo)]">
          <BrandMarkIcon />
        </span>
        <span className="relative pb-1.5">
          Pratibha
          <span className="absolute bottom-0 left-0 h-[2.5px] w-[34px] rounded-full bg-[var(--saffron)]" />
        </span>
      </Link>

      {groups.map((group) => (
        <div key={group.label}>
          <div className="px-2 pb-1.5 pt-3.5 text-[11px] font-semibold uppercase tracking-wide text-white/40">
            {group.label}
          </div>
          {group.links.map((link) => {
            const active = isActive(link.href, link.exact);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "-ml-[2.5px] flex items-center justify-between gap-2 rounded-lg border-l-[2.5px] py-1.5 pl-[10.5px] pr-2 font-medium no-underline hover:no-underline",
                  active
                    ? "border-[var(--saffron)] bg-white/10 font-semibold text-white"
                    : "border-transparent text-white/70 hover:bg-white/5 hover:text-white",
                ].join(" ")}
              >
                <span>{link.label}</span>
                {badges?.[link.label] ? (
                  <span className="inline-flex h-[19px] min-w-[19px] flex-none items-center justify-center rounded-full bg-[var(--saffron)] px-1.5 text-[11px] font-bold leading-none text-[var(--indigo)]">
                    {badges[link.label]}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}

      <QuotaMeters tenant={tenant} />

      <button
        type="button"
        className="mt-3.5 flex w-full items-start gap-2.5 rounded-xl border border-white/10 bg-white/5 px-[13px] py-3 text-left text-white hover:bg-white/10"
      >
        <span className="mt-[5px] h-2 w-2 flex-none rounded-full bg-[var(--saffron)]" />
        <span>
          <b className="block text-[13.5px] font-semibold">Ask Saarthi</b>
          <span className="mt-px block text-xs text-white/60">Product help, any time</span>
        </span>
      </button>

      <div className="mt-3">
        <ThemeToggle />
      </div>
    </nav>
  );
}

function BrandMarkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4 5.5C4 4.67 4.67 4 5.5 4h13c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5H9.7l-3.9 3.4c-.5.44-1.3.09-1.3-.58V16H5.5C4.67 16 4 15.33 4 14.5v-9Z"
        fill="currentColor"
      />
    </svg>
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
    <div className="mt-3.5 px-1 text-xs text-white/65">
      {showMinutes && (
        <div className="mb-2.5 last:mb-0">
          Interview minutes
          <span className="float-right font-semibold text-white">
            {minutes.used} / {minutes.limit}
          </span>
          <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-white/15">
            <div
              className={`h-full rounded-full ${
                minutes.level === "exhausted"
                  ? "bg-[var(--danger)]"
                  : minutes.level === "warning"
                    ? "bg-[var(--warning)]"
                    : "bg-[var(--saffron)]"
              }`}
              style={{ width: `${Math.min(100, (minutes.used / minutes.limit!) * 100)}%` }}
            />
          </div>

          {/* Customers reason in interviews and are billed in minutes. Always
              "roughly": it is an estimate, and saying so is what stops it being
              quoted back at us. */}
          <div className="mt-1 text-white/50">
            {minutes.remaining} left
            {minutes.approximateInterviewsRemaining !== null &&
              ` · roughly ${minutes.approximateInterviewsRemaining} ${
                minutes.approximateInterviewsRemaining === 1 ? "interview" : "interviews"
              }`}
          </div>

          {minutes.level === "exhausted" ? (
            <div className="mt-1.5 rounded bg-[var(--danger-soft)] px-1.5 py-1 text-[var(--danger)]">
              Out of minutes. Further interviews bill as overage.
            </div>
          ) : minutes.level === "warning" ? (
            <div className="mt-1.5 rounded bg-[var(--warning-soft)] px-1.5 py-1 text-[var(--warning)]">
              {Math.round((minutes.used / minutes.limit!) * 100)}% of your minutes used.
            </div>
          ) : null}
        </div>
      )}

      {screeningLimit !== null && (
        <div className="mb-2.5 last:mb-0">
          CV screenings
          <span className="float-right font-semibold text-white">
            {usage.meter.screeningsUsed} / {screeningLimit}
          </span>
          <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full rounded-full bg-[var(--saffron)]"
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