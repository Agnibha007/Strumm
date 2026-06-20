import type { Metadata, Viewport } from "next";
import { Outfit, Playfair_Display } from "next/font/google";
import "./globals.css";
import Providers from "web/components/Providers";
import AuthWrapper from "web/components/AuthWrapper";
import PersistentPlayerWrapper from "web/components/PersistentPlayerWrapper";
import NotificationToast from "web/components/NotificationToast";

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

export const metadata: Metadata = {
  title: {
    default: "Strumm - Where your music lives.",
    template: "%s | Strumm",
  },
  description: "Strumm is a premium, handcrafted music ecosystem. Where your music lives, custom playlists, dynamic theme engine, and smart listening stats.",
  metadataBase: new URL("https://strumm.pixelneststudios.tech"),
  applicationName: "Strumm",
  manifest: "/manifest.webmanifest",
  alternates: {
    canonical: "/",
  },
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
    url: "https://strumm.pixelneststudios.tech",
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
      </head>
      <body
        className={`${outfit.variable} ${playfair.variable} antialiased selection:bg-primary selection:text-white relative`}
      >
        <div className="fixed inset-0 z-[-1] pointer-events-none opacity-[0.15] transition-opacity duration-1000 bg-[radial-gradient(ellipse_at_top,_var(--color-primary)_0%,_transparent_60%)] mix-blend-screen" />
        <Providers>
          <AuthWrapper>
            {children}
          </AuthWrapper>
          <PersistentPlayerWrapper />
          <NotificationToast />
        </Providers>
      </body>
    </html>
  );
}
