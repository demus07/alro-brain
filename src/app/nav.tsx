"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const MAIN = [
  { href: "/", label: "Agent" },
  { href: "/updates", label: "Updates" },
  { href: "/graph", label: "Graph" },
  { href: "/commitments", label: "Promises" },
  { href: "/upload", label: "Upload" },
];

const SECONDARY = [
  { href: "/settings", label: "Settings" },
  { href: "/connectors", label: "Health" },
];

export function Nav() {
  const pathname = usePathname();
  const link = (t: { href: string; label: string }) => (
    <Link key={t.href} href={t.href} aria-current={pathname === t.href ? "page" : undefined}>
      {t.label}
    </Link>
  );
  return (
    <>
      <nav className="side-nav" aria-label="Main">
        {MAIN.map(link)}
      </nav>
      <nav className="side-nav secondary" aria-label="Settings">
        {SECONDARY.map(link)}
      </nav>
    </>
  );
}
