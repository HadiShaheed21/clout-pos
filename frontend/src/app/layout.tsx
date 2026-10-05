import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import MenuActionHandler from "@/components/layout/MenuActionHandler";
import AuthGuard from "@/components/layout/AuthGuard";
import { HtmlLangSync } from "@/components/layout/HtmlLangSync";
import { ThemeSync } from "@/components/layout/ThemeSync";
import { NumberInputWheelGuard } from "@/components/layout/NumberInputWheelGuard";
import { DirectionalToaster } from "@/components/layout/DirectionalToaster";
import DesktopDragSurface from "@/components/layout/DesktopDragSurface";
import { I18nProvider } from "@/components/providers/I18nProvider";

export const metadata: Metadata = {
  title: "Hadi POS",
  description: "Smart point of sale for clothing and retail stores",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Hadi POS",
  },
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#3248FF",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* gh-513 FOUC guard: apply the last-resolved palette before first
            paint. Priority: ?theme= URL param (standalone windows opened by
            main with the current palette) → localStorage mirror → system
            matchMedia. try/catch: worst case is one light flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var p=new URLSearchParams(location.search).get('theme');" +
              "var t=(p==='dark'||p==='light')?p:localStorage.getItem('flo-theme-resolved');" +
              "if(t==='dark'||(t!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)){" +
              'document.documentElement.classList.add(\'dark\');}}catch(e){}})();',
          }}
        />
      </head>
      <body
        className="antialiased"
      >
        <I18nProvider>
          <DesktopDragSurface />
          <MenuActionHandler />
          <HtmlLangSync />
          <ThemeSync />
          <NumberInputWheelGuard />
          <AuthGuard>{children}</AuthGuard>
          <DirectionalToaster />
        </I18nProvider>
        <Script id="sw-register" strategy="afterInteractive">
          {`
            if ('serviceWorker' in navigator) {
              // afterInteractive can run after 'load' has already fired, which
              // would leave a bare load listener waiting on an event that never
              // dispatches again. Register immediately in that case.
              var register = function () {
                navigator.serviceWorker.register('/sw.js').catch(function () {});
              };
              if (document.readyState === 'complete') {
                register();
              } else {
                window.addEventListener('load', register, { once: true });
              }
            }
          `}
        </Script>
      </body>
    </html>
  );
}
