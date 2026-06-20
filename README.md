# Strumm

> "Because music is priceless. 100% Free. Zero Ads. Forever."

Strumm is an ultra-premium, handcrafted music ecosystem designed to bring you the ultimate audio experience without the paywalls, interruptions, or subscriptions. Built with stunning editorial magazine aesthetics, Strumm proves that you don't need to compromise on design or features to enjoy unlimited music.

We believe music is a fundamental human right. It shouldn't be gated behind costly monthly subscriptions or interrupted by unskippable ads. Strumm is a passion project dedicated to delivering a flawless, high-fidelity listening experience that respects you and your music.

---

## 🌟 Why Strumm?

- **100% Free**: No premium tiers, no hidden costs. Every feature is unlocked for everyone.
- **Zero Ads**: Pure, uninterrupted playback. No audio ads, no banner ads, ever.
- **Premium Aesthetics**: A UI that feels like flipping through a high-end magazine, proving that free software can be beautiful.

---

## ✨ Features

### 🎧 Persistent Background Playback
A globally persistent music player that follows you across the app without ever dropping a beat. Fully integrated with your device's lock-screen controls via the Media Session API.

### 🎤 Fullscreen Karaoke Theatre
Immerse yourself in the music with a beautiful fullscreen theatre mode. Features real-time, dynamically synced lyrics that highlight exactly as the artist sings them.

### 📥 Unrestricted MP3 Downloads
Loved a track? Download it directly as a high-quality MP3 file to your local device. Never lose your music when you go offline, completely free of DRM and restrictions.

### 🎨 Stunning Editorial Themes
A handcrafted UI featuring dynamic gradients, micro-animations, and glassmorphism. Choose from curated themes like **Obsidian**, **Black Cherry**, **Vinyl Classic**, **Ocean Drive**, **Monochrome**, and **Aurora**. You can even upload your own custom backgrounds!

### 🧠 Smart LLM-Powered Curation
Not sure what to listen to? Let Strumm's intelligent **Flow** and **Discovery** modes (powered by the GROQ LLM API) instantly build custom playlists tailored to your exact mood and listening history.

### 🗂️ Universal Playlist Importer
Don't start from scratch. Easily import your existing library by uploading CSV files or directly pasting links from **Spotify** and **YouTube Music**. Strumm automatically searches and reconstructs your library!

### 📱 Responsive Mobile Experience
A seamless, native-feeling app experience on mobile devices. Features intuitive swipe-to-open navigation menus, an elegant mini-player, and touch-optimized controls.

---

## 🛠️ Architecture

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

## 🚀 Running Locally

### Prerequisites
* **Node.js**: >= 20.0
* **pnpm** or **npx pnpm**
* **Python**: >= 3.11
* **MongoDB**: Atlas Connection URI or Local Server
* **FFmpeg**: Installed and added to system PATH (required for MP3 extraction)

### 1. Setup Environment Configuration
Copy the environment templates and populate your keys:
* Frontend: `apps/web/.env.example` -> `apps/web/.env.local`
* Backend: `apps/api/.env.example` -> `apps/api/.env`

### 2. Initialize Workspaces & Launch Frontend
From the root `/strumm` folder:
```bash
# Install dependencies across all workspace modules
npx pnpm install

# Compile and start Next.js frontend in development mode
npx pnpm dev
```

### 3. Launch FastAPI Backend
From the `apps/api` folder:
```bash
# Install Python packages
pip install -r requirements.txt

# Start local server
uvicorn app.main:app --reload
```
The API documentation will be available at `http://localhost:8000/docs`.

---

**Enjoy the music, completely free and ad-free!** 🎶
