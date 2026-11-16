"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const path = (d: string) => <path d={d} />;

/** 16px stroke icons, drawn on a 24-unit grid. */
const ICONS: Record<string, ReactNode> = {
  Agent: path("M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z"),
  Updates: path("M6 9a6 6 0 1 1 12 0c0 6 2.5 7 2.5 7h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0"),
  Search: path("M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4"),
  Graph: path("M6 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM7 22a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8 5.5l7.8 3M15.7 11l-7.2 6.6M6.2 7l.5 10"),
  Promises: path("M4 12.5l5 5L20 6.5"),
  Scheduled: path("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2"),
  Overview: path("M4 13h6V4H4v9zM14 20h6v-9h-6v9zM4 20h6v-3H4v3zM14 7h6V4h-6v3z"),
  "Check facts": path("M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6l7-3zM9 12l2 2 4-4"),
  Approvals: path("M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11"),
  Team: path("M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM3 21v-1a6 6 0 0 1 12 0v1M16 3.1a4 4 0 0 1 0 7.8M21 21v-1a6 6 0 0 0-4-5.6"),
  Procedures: path("M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"),
  Trackers: path("M4 5h16v14H4zM4 10h16M4 15h16M10 5v14"),
  Upload: path("M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"),
  Settings: path("M4 7h10M18 7h2M4 17h2M10 17h10M14 4.5v5h4v-5h-4zM6 14.5v5h4v-5H6z"),
  Health: path("M3 12h4l3-7 4 14 3-7h4"),
};

const GROUPS = [
  {
    label: "Today",
    items: [
      { href: "/", label: "Agent" },
      { href: "/overview", label: "Overview" },
      { href: "/updates", label: "Updates" },
      { href: "/approvals", label: "Approvals" },
      { href: "/commitments", label: "Promises" },
    ],
  },
  {
    label: "Memory",
    items: [
      { href: "/search", label: "Search" },
      { href: "/memory", label: "Check facts" },
      { href: "/graph", label: "Graph" },
      { href: "/procedures", label: "Procedures" },
      { href: "/trackers", label: "Trackers" },
    ],
  },
  {
    label: "Work",
    items: [
      { href: "/team", label: "Team" },
      { href: "/routines", label: "Scheduled" },
    ],
  },
];

const SECONDARY = [
  { href: "/upload", label: "Upload" },
  { href: "/settings", label: "Settings" },
  { href: "/connectors", label: "Health" },
];

export function Nav() {
  const pathname = usePathname();
  const link = (t: { href: string; label: string }) => (
    <Link key={t.href} href={t.href} aria-current={pathname === t.href || (t.href !== "/" && pathname.startsWith(`${t.href}/`)) ? "page" : undefined}>
      <svg viewBox="0 0 24 24" aria-hidden>
        {ICONS[t.label]}
      </svg>
      {t.label}
    </Link>
  );
  return (
    <>
      {GROUPS.map((g) => (
        <nav key={g.label} className="side-nav" aria-label={g.label}>
          <span className="side-nav-label">{g.label}</span>
          {g.items.map(link)}
        </nav>
      ))}
      <nav className="side-nav secondary" aria-label="Settings">
        {SECONDARY.map(link)}
      </nav>
    </>
  );
}
