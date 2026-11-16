import Link from "next/link";
import { connection } from "next/server";
import { isAdmin, ROLE_LABEL } from "@/platform/roles";
import { currentViewer } from "@/lib/viewer";
import { signOutAction } from "./sign-in/actions";

/** Sidebar footer: who is signed in, with their account page and sign out. */
export async function AccountMenu() {
  await connection();
  const viewer = await currentViewer().catch(() => undefined);
  if (!viewer) return null;
  return (
    <>
      {isAdmin(viewer) && (
        <Link href="/admin" className="small link account-admin">
          Admin: people, usage, data →
        </Link>
      )}
      <div className="account">
        <Link href="/account" className="truncate" title={viewer.email}>
          {viewer.displayName}
          <span className="muted small"> · {ROLE_LABEL[viewer.role]}</span>
        </Link>
        {viewer.sessionId && (
          <form action={signOutAction}>
            <button className="chip-button">Sign out</button>
          </form>
        )}
      </div>
    </>
  );
}
