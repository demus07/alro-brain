"use client";

export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="card">
      <p className="label">Something went wrong</p>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <button type="button" onClick={retry} className="ghost">
        Try again
      </button>
    </div>
  );
}
