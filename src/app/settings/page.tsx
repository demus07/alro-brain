import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { defaultModels, modelId } from "@/ai/models";
import { AboutYou, LiveTools, Messaging } from "./sections";
import { Sources } from "./sources";

export const metadata: Metadata = { title: "Settings · ALRO" };

/** What came back from a sign-in round trip. */
async function Notice({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string }> }) {
  const { error, connected } = await searchParams;
  if (error) return <p className="notice error">{error}</p>;
  if (connected) return <p className="notice">Connected {connected}. The first sync runs in the background.</p>;
  return null;
}

export default function SettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string }> }) {
  const models = defaultModels();
  const rows = [
    { stage: "Answers questions", model: modelId(models.answer) },
    { stage: "Builds the knowledge graph", model: modelId(models.graph) },
    { stage: "Finds promises and facts", model: modelId(models.extract) },
    { stage: "Screens every message", model: modelId(models.screen) },
    { stage: "Search embeddings", model: `${modelId(models.embed)}${process.env.ALRO_EMBEDDING_BASE_URL ? " (local)" : ""}` },
  ];
  return (
    <div className="settings">
      <h1>Settings</h1>
      <Suspense fallback={null}>
        <Notice searchParams={searchParams} />
      </Suspense>

      <section className="settings-section">
        <div>
          <h2>Sources</h2>
          <p className="muted small">
            Where ALRO&apos;s memory comes from. Each source is read with a token or sign-in you give it, stored encrypted, and synced every 15 minutes. Sync status and costs are on{" "}
            <Link className="link" href="/connectors">
              Health
            </Link>
            .
          </p>
        </div>
        <Suspense fallback={<p className="muted small">Loading sources…</p>}>
          <Sources />
        </Suspense>
      </section>

      <section className="settings-section">
        <div>
          <h2>Live tools</h2>
          <p className="muted small">Apps the agent looks things up in at the moment you ask: a CRM, sheets, accounting. Nothing is copied into memory.</p>
        </div>
        <Suspense fallback={<p className="muted small">Loading…</p>}>
          <LiveTools />
        </Suspense>
      </section>

      <section className="settings-section">
        <div>
          <h2>About you</h2>
          <p className="muted small">Your personal brain: what you&apos;re working towards, how you decide and how you write. It shapes answers and drafts for you. Only you can see it.</p>
        </div>
        <Suspense fallback={<p className="muted small">Loading…</p>}>
          <AboutYou />
        </Suspense>
      </section>

      <section className="settings-section">
        <div>
          <h2>Messaging</h2>
          <p className="muted small">Ask ALRO from the apps you already use, by text or voice note. Briefs, reminders and scheduled results arrive there too.</p>
        </div>
        <Suspense fallback={<p className="muted small">Loading…</p>}>
          <Messaging />
        </Suspense>
      </section>

      <section className="settings-section">
        <div>
          <h2>Your data</h2>
          <p className="muted small">Everything ALRO holds that you can see. Deleting a source above removes it and everything found only in it.</p>
        </div>
        <div>
          <a className="button-link" href="/api/export" download>
            Export as JSON
          </a>
        </div>
      </section>

      <section className="settings-section">
        <div>
          <h2>Models</h2>
          <p className="muted small">Set in .env.local (ALRO_*_MODEL). Changing the embedding model means re-indexing.</p>
        </div>
        <table>
          <tbody>
            {rows.map((r) => (
              <tr key={r.stage}>
                <td>{r.stage}</td>
                <td className="mono small">{r.model}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
