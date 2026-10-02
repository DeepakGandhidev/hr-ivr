"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Brand } from "@/components/Brand";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/workspaces", label: "Workspaces" },
  { href: "/plans", label: "Plans and pricing" },
  { href: "/coupons", label: "Coupons" },
  { href: "/payments", label: "Payments" },
  { href: "/calls", label: "Calls" },
  { href: "/activity", label: "Activity" },
  { href: "/settings", label: "Platform settings" },
  { href: "/team", label: "Admin team" },
];

export function Sidebar({ name, roleTitle }: { name: string; roleTitle: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST" }).catch(() => {});
    router.replace("/sign-in");
    router.refresh();
  }

  return (
    <nav className="sidebar" aria-label="Admin">
      <Brand />
      <div className="nav">
        {LINKS.map((l) => {
          const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
          return (
            <Link key={l.href} href={l.href} className={active ? "active" : undefined}>
              {l.label}
            </Link>
          );
        })}
      </div>
      <div className="whoami">
        <div className="avatar">{name.slice(0, 1).toUpperCase()}</div>
        <div>
          <div className="whoami-name">{name}</div>
          <div className="whoami-role">{roleTitle}</div>
        </div>
        <button className="signout" type="button" onClick={signOut} style={{ marginLeft: "auto" }}>
          Sign out
        </button>
      </div>
    </nav>
  );
}
