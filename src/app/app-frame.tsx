"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Pages someone sees before they're signed in, or while setting up: no sidebar. */
const BARE = /^\/(sign-in|sign-up|invite|reset|welcome)(\/|$)/;

/** The app's frame: sidebar plus page, or just the page for sign-in and setup. */
export function AppFrame({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const bare = BARE.test(usePathname());
  if (bare) return <main className="shell bare">{children}</main>;
  return (
    <div className="app">
      <aside className="sidebar">{sidebar}</aside>
      <main className="shell">{children}</main>
    </div>
  );
}
