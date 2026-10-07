import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono, Schibsted_Grotesk } from "next/font/google";
import { site } from "@/config/site";
import { ContactModal } from "@/components/support/contact-modal";
import "./globals.css";

const sans = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.title, template: `%s · ${site.name}` },
  description: site.description,
  applicationName: site.name,
  keywords: [
    "AI test generation",
    "Playwright",
    "QA automation",
    "human-in-the-loop testing",
    "end-to-end testing",
    "CI testing",
    "test case review",
    "GitHub Actions",
    "GitLab CI",
    "Bitbucket Pipelines"
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: site.name,
    title: site.title,
    description: site.description,
    locale: site.locale
  },
  twitter: { card: "summary_large_image", title: site.title, description: site.description },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large" } },
  formatDetection: { telephone: false, email: false, address: false },
  category: "technology"
};

export const viewport: Viewport = {
  themeColor: "#0a0d0f",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body suppressHydrationWarning>
        {children}
        <ContactModal />
      </body>
    </html>
  );
}
