import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { Providers } from "@/components/providers";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Marketplace360 Dashboard",
  description: "Unified Amazon Analytics powered by AI Insights, Forecasting, and Smart Automation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} h-full antialiased`}
      // The theme-init script below intentionally adds "dark" to this
      // element before React hydrates, so the server-rendered className
      // (which knows nothing about the saved preference) never matches the
      // client's — expected and harmless for this one attribute.
      suppressHydrationWarning
    >
      <head>
        {/* Applies the saved theme before first paint (avoids a flash of the
            wrong theme) and on every full page load/reload — Settings'
            toggle only mutates the live DOM, so without this the "dark"
            class was lost the moment that page unmounted or the tab reloaded.
            next/script + beforeInteractive (rather than a raw <script> tag)
            is Next.js's documented way to run this before hydration. */}
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `try{var s=localStorage.getItem("ppcUserSettings");var t=s&&JSON.parse(s).theme;if(t==="dark")document.documentElement.classList.add("dark");}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
