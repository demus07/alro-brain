import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { defaultModels, modelId } from "@/ai/models";
import { Sources } from "./sources";

export const metadata: Metadata = { title: "Settings · ALRO" };

export default function SettingsPage() {
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

      <section className="settings-section">
        <div>
          <h2>Sources</h2>
          <p className="muted small">
            Where ALRO&apos;s memory comes from. Live connectors are coming; until then, upload exports. Sync status and costs are on{" "}
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
