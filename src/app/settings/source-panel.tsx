"use client";

import { useCallback, useId, useRef, type ReactNode } from "react";
import { SourceIcon } from "../source-icon";

/**
 * A source's tile with one button that slides a panel in from the right holding everything needed
 * to connect it. The grid of tiles never moves. Built on <dialog> opened as a modal: focus stays in
 * the panel, Escape or a click outside closes it, and focus goes back to the button.
 */
export function SourcePanel({
  provider,
  label,
  action,
  subtitle,
  dim,
  children,
}: {
  provider: string;
  label: string;
  /** The tile's button: Connect, Set up, Upload. */
  action: string;
  /** A line under the name on the tile, e.g. "Needs a Google app". */
  subtitle?: string;
  /** Faded: the source can't be connected until something is set up. */
  dim?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useCallback(() => dialog.current?.close(), []);
  return (
    <>
      <div className={dim ? "source-tile dim" : "source-tile"}>
        <SourceIcon provider={provider} />
        <span className="source-text">
          <span className="source-name truncate">{label}</span>
          {subtitle && <span className="muted small truncate">{subtitle}</span>}
        </span>
        <button type="button" className="chip-button" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>
          {action}
        </button>
      </div>
      <dialog
        ref={dialog}
        className="side-panel"
        aria-labelledby={titleId}
        // A click on the backdrop lands on the dialog itself, outside its content.
        onClick={(e) => e.target === e.currentTarget && close()}
      >
        <div className="side-panel-inner">
          <header className="side-panel-head">
            <SourceIcon provider={provider} />
            <h2 id={titleId} className="truncate">
              {label}
            </h2>
            <button type="button" className="icon-button" aria-label="Close" onClick={close}>
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </header>
          <div className="side-panel-body">
            {children}
          </div>
        </div>
      </dialog>
    </>
  );
}
