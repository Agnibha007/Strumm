import type { Metadata, Viewport } from "next";
import { Outfit, Playfair_Display } from "next/font/google";
import "./globals.css";
import Providers from "web/components/Providers";
import AuthWrapper from "web/components/AuthWrapper";
import PersistentPlayerWrapper from "web/components/PersistentPlayerWrapper";
import NotificationToast from "web/components/NotificationToast";
import { RealTimeProvider } from "web/services/realtime";
import ConditionalFooter from "web/components/ConditionalFooter";
import FeedbackButton from "web/components/FeedbackButton";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: {
    default: "Strumm - Where your music lives.",
    template: "%s | Strumm",
  },
  description: "Strumm is a premium, handcrafted music ecosystem. Where your music lives, custom playlists, dynamic theme engine, and smart listening stats.",
  metadataBase: new URL(appUrl),
  applicationName: "Strumm",
  manifest: "/manifest.webmanifest",
  // No global canonical — each page defines its own via generateMetadata.
  // A blanket canonical: "/" would tell Google every page is the homepage.
  keywords: ["Strumm", "music player", "podcasts", "playlists", "lyrics", "music streaming"],
  authors: [{ name: "Strumm" }],
  creator: "Strumm",
  publisher: "Strumm",
  category: "music",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/icon.png", type: "image/png" },
    ],
    apple: "/apple-icon.png",
  },
  openGraph: {
    title: "Strumm - Where your music lives.",
    description: "Experience music in a premium, editorial design. High-fidelity audio, listening history, custom themes, and smart music flow.",
    url: appUrl,
    siteName: "Strumm",
    images: [
      {
        url: "/strumm-logo.png",
        width: 1200,
        height: 1200,
        alt: "Strumm Music Ecosystem",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Strumm - Where your music lives.",
    description: "Premium, handcrafted music ecosystem built for music enthusiasts.",
    images: ["/strumm-logo.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  appleWebApp: {
    capable: true,
    title: "Strumm",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#080808",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="Obsidian" data-scroll-behavior="smooth" className="scroll-smooth" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var cached = localStorage.getItem('strumm-theme-cache');
                if (cached) {
                  var state = JSON.parse(cached).state;
                  if (state && state.currentTheme) {
                    document.documentElement.setAttribute('data-theme', state.currentTheme);
                    if (state.extractedColor) {
                      document.documentElement.style.setProperty('--extracted-color', state.extractedColor);
                    }
                  }
                }
              } catch (e) {}
            `
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              "name": "Strumm",
              "url": appUrl,
              "description": "Strumm is a premium, handcrafted music ecosystem. Where your music lives, custom playlists, dynamic theme engine, and smart listening stats.",
              "potentialAction": {
                "@type": "SearchAction",
                "target": `${appUrl}/search?q={search_term_string}`,
                "query-input": "required name=search_term_string"
              }
            })
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              "name": "Strumm",
              "url": appUrl,
              "logo": `${appUrl}/strumm-logo.png`,
              "sameAs": [
                "https://github.com/strumm/strumm"
              ]
            })
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              "name": "Strumm",
              "operatingSystem": "Web",
              "applicationCategory": "MusicApplication",
              "offers": {
                "@type": "Offer",
                "price": "0",
                "priceCurrency": "USD"
              },
              "description": "Strumm is a premium, handcrafted music ecosystem. Where your music lives, custom playlists, dynamic theme engine, and smart listening stats.",
              "url": appUrl
            })
          }}
        />

      </head>
      <body
        className={`${outfit.variable} ${playfair.variable} antialiased selection:bg-primary selection:text-white relative flex flex-col min-h-screen pb-20 md:pb-24`}
      >
        <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[999] focus:px-4 focus:py-2 focus:bg-primary focus:text-white focus:rounded-lg focus:text-sm focus:font-semibold focus:outline-none">
          Skip to content
        </a>
        <div className="fixed inset-0 z-[-1] pointer-events-none opacity-[0.15] transition-opacity duration-1000 bg-[radial-gradient(ellipse_at_top,_var(--color-primary)_0%,_transparent_60%)] mix-blend-screen" />
        <Providers>
          <AuthWrapper>
            <RealTimeProvider>
              {children}
            </RealTimeProvider>
          </AuthWrapper>
          <PersistentPlayerWrapper />
          <NotificationToast />
          <ConditionalFooter />
          <FeedbackButton />
        </Providers>
      </body>
    </html>
  );
}
