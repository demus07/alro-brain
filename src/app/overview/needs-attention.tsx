import Link from "next/link";
import { askHref, KIND_LABEL, SEVERITY_LABEL, subjectHref } from "@/insights/read";
import { dismiss } from "./actions";

export interface AttentionItem {
  id: string;
  kind: string;
  title: string;
  detail: string;
  suggestion: string | null;
  severity: number;
  subjectEntityId: string | null;
  subjectPersonId: string | null;
}

/**
 * What ALRO noticed, most urgent first. Each suggestion opens the agent with it already
 * asked; Dismiss hides the insight until it changes.
 */
export function NeedsAttention({ items, empty }: { items: AttentionItem[]; empty?: string }) {
  if (!items.length) return empty ? <p className="muted small">{empty}</p> : null;
  return (
    <article className="card">
      {items.map((i) => {
        const href = subjectHref(i);
        return (
          <div key={i.id} className="todo">
            <div className="card-head">
              <span className={`dot ${i.severity >= 3 ? "bad" : i.severity === 2 ? "stale" : ""}`} title={SEVERITY_LABEL[i.severity]} />
              <strong className="truncate">
                {href ? (
                  <Link className="link" href={href}>
                    {i.title}
                  </Link>
                ) : (
                  i.title
                )}
              </strong>
              <span className="tag">{KIND_LABEL[i.kind as keyof typeof KIND_LABEL] ?? i.kind}</span>
            </div>
            <p className="muted small">{i.detail}</p>
            <form action={dismiss} className="actions">
              <input type="hidden" name="id" value={i.id} />
              {i.suggestion && (
                <Link className="link small" href={askHref(i.suggestion)}>
                  {i.suggestion} →
                </Link>
              )}
              <button className="chip-button">Dismiss</button>
            </form>
          </div>
        );
      })}
    </article>
  );
}
