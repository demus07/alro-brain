import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
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

export const metadata: Metadata = {
  title: "ALRO",
  description: "Company memory that answers with sources and tracks promises until they're kept.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <div className="app">
          <aside className="sidebar">
            <div className="brand">
              <span className="brand-mark">A</span>
              <span>alro</span>
            </div>
            <Nav />
            <div className="sidebar-foot">
              <Suspense fallback={<span className="small muted">…</span>}>
                <SyncStatus />
              </Suspense>
            </div>
          </aside>
          <main className="shell">{children}</main>
        </div>
      </body>
    </html>
  );
}
