import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { setupSteps } from "@/platform/onboarding";
import { isAdmin } from "@/platform/roles";
import { finishSetup, saveGoals, skipStep } from "./actions";

export const metadata: Metadata = { title: "Set up · ALRO" };

export default function WelcomePage() {
  return (
    <div className="welcome">
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Welcome />
      </Suspense>
    </div>
  );
}

async function Welcome() {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const { steps } = await setupSteps(db, viewer);
  const admin = isAdmin(viewer);
  const left = steps.filter((s) => !s.done && !s.optional).length;
  const next = steps.find((s) => !s.done);
  return (
    <>
      <div>
        <h1>Welcome, {viewer.displayName.split(/\s+/)[0]}</h1>
        <p className="muted">
          {admin ? `Let's get ${org.name} set up.` : `You've joined ${org.name}.`} You don&apos;t have to do it all now: the list keeps itself up to date, and you can come back to it from your account.
        </p>
      </div>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.id} className="card">
            <header className="card-head">
              <span className={`step-number${s.done ? " done" : ""}`} aria-label={s.done ? "Done" : `Step ${i + 1}`}>
                {s.done ? "✓" : i + 1}
              </span>
              <strong>{s.title}</strong>
              {s.status && <span className="muted small truncate">{s.status}</span>}
            </header>
            {(!s.done || s === next) && <p className="muted small">{s.detail}</p>}
            {s.id === "goals" && !s.done && (
              <form action={saveGoals} className="connect-form">
                <textarea name="goals" rows={3} placeholder={"One per line, e.g.\nClose the Tata renewal by December\nGet receivables under 45 days"} aria-label="Goals, one per line" required />
                <div className="row">
                  <button>Save goals</button>
                  <Link className="button-link" href={`/?ask=${encodeURIComponent("Interview me so you know how I work")}`}>
                    Let ALRO interview me instead
                  </Link>
                </div>
              </form>
            )}
            {(s.href || (!s.done && s.optional && admin)) && (
              <div className="row">
                {s.href && (
                  <Link className={s.done ? "chip-button" : "button-link"} href={s.href}>
                    {s.action} →
                  </Link>
                )}
                {!s.done && admin && (s.optional || s.id === "review") && (
                  <form action={skipStep} className="actions">
                    <input type="hidden" name="step" value={s.id} />
                    <button className="chip-button">{s.id === "review" ? "I've checked" : "Skip for now"}</button>
                  </form>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      <form action={finishSetup}>
        <button>{left ? "Continue to ALRO" : "Start using ALRO"}</button>
      </form>
    </>
  );
}
