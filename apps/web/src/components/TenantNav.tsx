"use client";

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

      <ThemeToggle />
    </nav>
  );
}
