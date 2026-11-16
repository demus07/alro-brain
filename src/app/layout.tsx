import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { Suspense } from "react";
import { AccountMenu } from "./account-menu";
import { AppFrame } from "./app-frame";
import { Nav } from "./nav";
import { SyncStatus } from "./sync-status";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ALRO",
  description: "Company memory that answers with sources and tracks promises until they're kept.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable}`}>
      <body>
        {/* The frame reads the current path (no sidebar on sign-in and setup pages), known only per request. */}
        <Suspense fallback={null}>
          <AppFrame
            sidebar={
              <>
                <div className="brand">
                  <span className="brand-mark">a</span>
                  <span>alro</span>
                </div>
                <Suspense fallback={null}>
                  <Nav />
                </Suspense>
                <div className="sidebar-foot">
                  <Suspense fallback={null}>
                    <AccountMenu />
                  </Suspense>
                  <Suspense fallback={<span className="small muted">…</span>}>
                    <SyncStatus />
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
