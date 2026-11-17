"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

const KEY = "alro-theme";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

const ICON: Record<Theme, string> = {
  system: "M4 5h16v11H4zM9 20h6M12 16v4",
  light: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  dark: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
};

/**
 * Runs in <head> before the page paints, so a chosen theme never flashes the other one first.
 * Kept tiny and self-contained: it only reads the saved choice and sets data-theme on <html>.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Private windows can refuse storage; the choice still holds for this page.
  }
}

/** The sidebar's theme switch: System → Light → Dark. Remembered in this browser. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  // The saved choice is only known in the browser (the script above already applied it).
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with what the head script applied before hydration
    if (t === "light" || t === "dark") setTheme(t);
  }, []);
  const next = NEXT[theme];
  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      onClick={() => {
        apply(next);
        setTheme(next);
      }}
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}`}
      title={`Theme: ${LABEL[theme]} (click for ${LABEL[next]})`}
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d={ICON[theme]} />
      </svg>
    </button>
  );
}

/**
 * The theme actually showing ("light" or "dark"): the switch's choice, else the system's. Follows
 * both live, for components that draw their own colours (the Agent composer's border beam).
 */
export function useResolvedTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const read = () => {
      const chosen = document.documentElement.dataset.theme;
      setTheme(chosen === "light" || chosen === "dark" ? chosen : media.matches ? "dark" : "light");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", read);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", read);
    };
  }, []);
  return theme;
}
