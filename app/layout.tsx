import type { Metadata, Viewport } from "next";
import { Caveat, Inter } from "next/font/google";
import "./globals.css";

const tutorHand = Caveat({ subsets: ["latin"], weight: ["500"], variable: "--font-tutor" });
const ui = Inter({ subsets: ["latin"], variable: "--font-ui" });

export const metadata: Metadata = {
  title: "Tutor",
  description: "A private tutor on an infinite page that helps you learn by working it out yourself.",
  appleWebApp: { capable: true, title: "Tutor", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#fbfaf6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${tutorHand.variable} ${ui.variable}`}>
      <body>{children}</body>
    </html>
  );
}
