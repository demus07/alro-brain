import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import { Suspense } from "react";
import { AccountMenu } from "./account-menu";
import { AppFrame } from "./app-frame";
import { Nav, SearchLink } from "./nav";
import { SyncStatus } from "./sync-status";
import { THEME_SCRIPT } from "./theme-toggle";
import "./globals.css";

/** Text and controls. */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

/** Large headings. */
const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

/** Codes and keys. */
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ALRO",
  description: "Company memory that answers with sources and tracks promises until they're kept.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Applies a chosen light or dark theme before the first paint (data-theme is set on <html>, hence suppressHydrationWarning). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {/* The frame reads the current path (no sidebar on sign-in and setup pages), known only per request. */}
        <Suspense fallback={null}>
          <AppFrame
            sidebar={
              <>
                <div className="brand">
                  <span className="brand-mark" aria-hidden>
                    a
                  </span>
                  <span className="brand-name">ALRO</span>
                </div>
                <SearchLink />
                <Suspense fallback={null}>
                  <Nav />
                </Suspense>
                <div className="sidebar-foot">
                  <Suspense fallback={null}>
                    <SyncStatus />
                  </Suspense>
                  <Suspense fallback={null}>
                    <AccountMenu />
                  </Suspense>
                </div>
              </>
            }
          >
            {children}
          </AppFrame>
        </Suspense>
      </body>
    </html>
  );
}
