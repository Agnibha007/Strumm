import type { Metadata, Viewport } from "next";
import { Outfit, Playfair_Display } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import Providers from "web/components/Providers";
import AuthWrapper from "web/components/AuthWrapper";
import PersistentPlayerWrapper from "web/components/PersistentPlayerWrapper";
import NotificationToast from "web/components/NotificationToast";
import { RealTimeProvider } from "web/services/realtime";
import ConditionalFooter from "web/components/ConditionalFooter";

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
const logoUrl = `${appUrl}/strumm-logo.png`;

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: "Strumm — Where your music lives.",
    template: "%s | Strumm",
  },
  description:
    "Strumm is a free-to-use music discovery app with playlists, AI-assisted recommendations, podcasts, lyrics, and listening analytics. Strumm does not insert its own ads; playback providers may show ads, and limited diagnostics are disclosed in the Privacy Policy.",
  applicationName: "Strumm",
  manifest: "/manifest.webmanifest",
  keywords: [
    "Strumm",
    "music player",
    "podcasts",
    "playlists",
    "lyrics",
    "music streaming",
    "AI music recommendations",
    "music analytics",
    "free music app",
    "YouTube music player",
  ],
  authors: [{ name: "Strumm", url: appUrl }],
  creator: "Strumm",
  publisher: "Strumm",
  category: "music",
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
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/strumm-icon.png", type: "image/png", sizes: "512x512" },
      { url: "/strumm-icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [
      { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Strumm",
    title: "Strumm — Where your music lives.",
    description:
      "Free-to-use music discovery with AI-assisted playlists, podcast support, listening analytics, and dynamic themes. Strumm does not insert its own ads; embedded providers may show ads.",
    url: appUrl,
    images: [
      {
        url: "/strumm-og.png",
        width: 1200,
        height: 630,
        alt: "Strumm Music Ecosystem",
      },
      {
        url: "/strumm-logo.png",
        width: 800,
        height: 800,
        alt: "Strumm Logo",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@strumm",
    creator: "@strumm",
    title: "Strumm — Where your music lives.",
    description:
      "Free-to-use music discovery with AI-assisted playlists, podcasts, listening analytics, and dynamic themes; limited diagnostics are disclosed in the Privacy Policy.",
    images: ["/strumm-og.png"],
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Nonce generated per-request by middleware, required by our CSP so inline
  // scripts are allowed without weakening it with 'unsafe-inline'.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" data-theme="Obsidian" data-scroll-behavior="smooth" className="scroll-smooth" suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
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
                  document.documentElement.setAttribute('data-reduced-motion', state && state.isAnimated === false ? 'true' : 'false');
                }
              } catch (e) {}
            `,
          }}
        />

        {/* Organization schema — homepage Knowledge Graph */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "Strumm",
              legalName: "Strumm Music Ecosystem",
              url: appUrl,
              logo: logoUrl,
              image: logoUrl,
              description:
                "Strumm is a free-to-use music discovery app with AI-assisted recommendations, playlists, podcast support, and listening analytics.",
              email: "hello@strumm.me",
              foundingDate: "2024",
              founder: {
                "@type": "Person",
                name: "Strumm Team",
              },
              sameAs: [
                "https://github.com/Agnibha007/Strumm",
              ],
            }),
          }}
        />

        {/* Website schema + SearchAction */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              "@id": `${appUrl}#website`,
              name: "Strumm",
              url: appUrl,
              description:
                "Strumm is a free-to-use music discovery app — playlists, podcasts, AI-assisted curation, and listening analytics.",
              inLanguage: "en-US",
              publisher: {
                "@type": "Organization",
                name: "Strumm",
                logo: logoUrl,
              },
              potentialAction: {
                "@type": "SearchAction",
                target: {
                  "@type": "EntryPoint",
                  urlTemplate: `${appUrl}/search?q={search_term_string}`,
                },
                "query-input": "required name=search_term_string",
              },
            }),
          }}
        />

        {/* WebApplication schema */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": ["WebApplication", "SoftwareApplication"],
              name: "Strumm",
              url: appUrl,
              applicationCategory: "MusicApplication",
              operatingSystem: "Web",
              browserRequirements: "Requires a modern browser with JavaScript enabled. Supports Chrome, Firefox, Safari, Edge.",
              description:
                "Strumm is a free-to-use music discovery app with AI-assisted curation, YouTube-powered playback, podcasts, synchronized lyrics when available, and listening analytics.",
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
              },
              featureList: [
                "AI-powered music recommendations and playlist curation (Strumm Flow)",
                "YouTube music streaming with search",
                "Podcast subscriptions and playback",
                "Synchronized lyrics display when timed lyrics are available",
                "Listening statistics and Sound DNA analysis",
                "Customizable dynamic theme engine",
                "Social Circle with friend activity and shared listening",
                "Cross-device player state sync",
                "PWA support with offline app shell",
                "No Strumm-inserted ad placements or sale of listening data; Sentry diagnostics and YouTube provider behavior are disclosed in the Privacy Policy",
              ],
              screenshot: `${appUrl}/strumm-og.png`,
            }),
          }}
        />

      </head>
      <body
        className={`${outfit.variable} ${playfair.variable} antialiased selection:bg-primary selection:text-white relative flex flex-col min-h-screen pb-[136px] md:pb-24`}
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
        </Providers>
      </body>
    </html>
  );
}
