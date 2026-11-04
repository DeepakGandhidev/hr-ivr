import type { Metadata } from "next";
import { settingText } from "@pratibha/shared/settings-runtime";
import "./globals.css";
import { THEME_SCRIPT } from "@/lib/theme";
import SaarthiChat from "@/components/SaarthiChat";
import { saarthiConfig } from "@/lib/saarthi";

/**
 * From the admin panel (Brand, Product). Read per render on dynamic pages; a
 * page Next prerenders at build time keeps the wording the build saw.
 */
export function generateMetadata(): Metadata {
  return {
    title: settingText("brand.site_title", "Pratibha — AI Hiring Agent"),
    description: settingText(
      "brand.site_description",
      "Screen and interview candidates automatically, from application to shortlist."
    ),
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const saarthi = saarthiConfig();
  return (
    // suppressHydrationWarning: the script above sets data-theme on <html>
    // before hydration, so the server markup and the live DOM differ by that
    // one attribute by design.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* Brand faces from the reference design. Loaded by link rather than
            next/font because the reference names them explicitly and both
            carry real fallbacks in the token, so a blocked CDN degrades to
            Georgia and the system sans instead of to nothing. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700;12..96,800&family=Public+Sans:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        {/* Anonymous Saarthi chat on public pages; workspace pages run their own, signed in. */}
        {saarthi.publicOn && <SaarthiChat siteKey={saarthi.siteKey} widgetUrl={saarthi.widgetUrl} publicOnly />}
      </body>
    </html>
  );
}
