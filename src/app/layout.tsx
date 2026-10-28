import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
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
        <div className="shell">
          <nav className="nav">
            <Link href="/">
              <strong>ALRO</strong>
            </Link>
            <Link href="/">Ask</Link>
            <Link href="/commitments">Commitments</Link>
            <Link href="/upload">Upload</Link>
            <Link href="/connectors">Connectors</Link>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
