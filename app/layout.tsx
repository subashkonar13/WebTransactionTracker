import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Transaction Tracker",
  description: "A private dashboard for your credit-card transactions from Gmail.",
  robots: { index: false, follow: false }, // never surface in search engines
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
