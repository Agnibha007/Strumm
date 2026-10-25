# Strumm

> "Because music is priceless. Free to use. No Strumm-served ads."

Strumm is a free-to-use music discovery and listening app with playlists, lyrics, podcasts, listening stats, and social listening. It pairs an editorial interface with AI-assisted curation and a persistent player. Music playback is provided by third-party sources, so track availability, playback behavior, and any provider-served ads depend on those services.

Strumm does not sell users' listening data or insert its own advertising placements. It does use Sentry for application diagnostics, including sampled session replay, and embedded YouTube content may process activity under Google's own policies.

---

## ❖ Why Strumm?

- **Free to use**: No subscription tier is required for the features currently available.
- **No Strumm-served ads**: Strumm does not insert its own ad placements. The embedded playback provider may still serve ads.
- **Privacy-conscious**: Listening history powers requested features such as Replay and recommendations. Sentry is used for limited error/performance diagnostics and sampled, masked session replay; see the Privacy Policy.
- **Premium aesthetics**: An editorial interface with themes, motion, and customizable backgrounds.

---

## ✦ Features

### ⊳ Persistent Background Playback
A persistent player designed to survive in-app navigation, with browser Media Session integration for supported lock screens and media controls. Background playback behavior still depends on the browser, device, and availability of the playback source.

### ⊳ Fullscreen Karaoke Theatre
A fullscreen lyrics view highlights lines in time when synchronized lyrics and timestamps are available. If a track only has plain lyrics—or no matching lyrics—the interface reports that limitation rather than promising synchronization for every track.

### ⊳ Streaming and Offline Limitations
Strumm plays music from third-party sources and does not currently provide song-to-MP3 downloads or an offline music library. The PWA caches parts of the application shell, but music playback requires an internet connection. Download and offline support would require a separately designed feature compatible with the content provider’s permissions and licensing.

### ⊳ Stunning Editorial Themes
A handcrafted UI featuring dynamic gradients, micro-animations, and glassmorphism. Choose from curated themes like **Obsidian**, **Black Cherry**, **Vinyl Classic**, **Ocean Drive**, **Monochrome**, and **Aurora**. You can even upload your own custom backgrounds!

### ⊳ Smart LLM-Powered Curation
Not sure what to listen to? **Flow** and **Discovery** can generate mood-based curation and recommendations using the Groq API when the service is configured and available. Results depend on the prompt, available metadata, provider responses, and the user data used by each flow.

### ⊳ Multi-Source Playlist Importer
Import track lists from CSV, public Spotify playlist/album links, and YouTube Music playlists. Track matching is best-effort and depends on the source being publicly accessible and the external providers responding; private Spotify libraries are not imported via account authorization.

### ⊳ Responsive Mobile Experience
A responsive web/PWA experience with touch-friendly navigation, a mini-player, and mobile layouts. A native React Native companion is a roadmap item; this repository contains the web app and API, not a shipped native mobile app.

---

## ⎈ Architecture

Strumm operates as a modern monorepo leveraging Turborepo and pnpm workspaces.

```text
strumm/
├── apps/
│   ├── web/           # Next.js 15 (React 19, TypeScript, Tailwind CSS v4, Framer Motion, Zustand)
│   └── api/           # FastAPI (Python 3.11, Motor Async MongoDB, yt-dlp)
└── packages/
    ├── types/         # Shared TypeScript interfaces
    ├── ui/            # Shared React UI components
    └── config/        # Global configurations
```

---

## ⏵ Guidelines

* **Respect Artists**: While Strumm is free, we encourage supporting your favorite artists directly through merch or live shows whenever possible.
* **Open Source Spirit**: Strumm is built by the community, for the community. If you love the app, consider contributing to its development.
* **Privacy**: Strumm does not sell listening data or insert its own ads. The service stores listening history for product features and sends limited diagnostics (including masked session replay) to Sentry when configured. YouTube embeds may use their own cookies/storage and may show provider-served ads; see the in-app Privacy and Cookie Policies.
* **No Commercial Use**: Strumm is strictly designed for personal, non-commercial listening.

---

**Explore and listen with Strumm, free to use. Provider behavior and availability apply to embedded playback.**
