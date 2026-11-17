import Link from "next/link";
import type { CSSProperties } from "react";
import { connection } from "next/server";
import { isAdmin, ROLE_LABEL } from "@/platform/roles";
import { currentViewer } from "@/lib/viewer";
import { signOutAction } from "./sign-in/actions";
import { ThemeToggle } from "./theme-toggle";

/** Up to two initials for the avatar. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** A stable hue per name, so each person's avatar keeps its colour. */
const hue = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** Sidebar footer: who is signed in, with their account page and sign out. */
export async function AccountMenu() {
  await connection();
  const viewer = await currentViewer().catch(() => undefined);
  if (!viewer) return null;
  return (
    <>
      {isAdmin(viewer) && (
        <nav className="side-nav" aria-label="Admin">
          <Link href="/admin">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6l7-3z" />
            </svg>
            Admin
          </Link>
        </nav>
      )}
      <div className="account">
        <Link href="/account" className="account-link" title={viewer.email}>
          <span className="avatar" style={{ "--hue": hue(viewer.displayName) } as CSSProperties} aria-hidden>
            {initials(viewer.displayName)}
          </span>
          <span className="account-text">
            <span className="truncate">{viewer.displayName}</span>
            <span className="truncate account-role">{ROLE_LABEL[viewer.role]}</span>
          </span>
        </Link>
        <ThemeToggle />
        {viewer.sessionId && (
          <form action={signOutAction}>
            <button className="icon-button" aria-label="Sign out" title="Sign out">
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" />
              </svg>
            </button>
          </form>
        )}
      </div>
    </>
  );
}
