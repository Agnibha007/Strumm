# Strumm
> "Where your music lives."

Strumm is a premium, handcrafted music ecosystem rebuilt with editorial magazine design aesthetics. It operates as a monorepo leveraging Turborepo and pnpm workspaces, featuring a Next.js 15 frontend and a FastAPI (Python) backend.

---

## Workspace Structure
```text
strumm/
├── apps/
│   ├── web/           # Next.js 15 (React 19, TypeScript, Tailwind CSS v4, Framer Motion, Zustand)
│   └── api/           # FastAPI (Python 3.11, Motor Async MongoDB, Pydantic v2)
└── packages/
    ├── types/         # Shared TypeScript interfaces
    ├── ui/            # Shared React UI components
    ├── database/      # Database helper layers
    └── config/        # Global configurations
```

---

## Features

### 1. Premium Editorial Aesthetics
* Customized design language (Default theme: **Obsidian**).
* Curated theme options: **Obsidian**, **Black Cherry**, **Vinyl Classic**, **Ocean Drive**, **Monochrome**, and **Aurora**.
* Local cache theme loader to prevent visual flashes.
* Custom background image uploads and Micro-Animations power-saver switch.

### 2. Audio Engine & Persistent Player
* Globally persistent player built using the HTML5 **Media Session API** for lock-screen controls.
* Stream resolving internally powered by a hidden **YouTube Iframe Player API** instance.
* Volume memory tracking and shuffle/repeat modes.
* **Live Listening Counter**: Local listening timer that logs listening durations and syncs with the backend statistics engine every 30 seconds of playing.

### 3. Smart Curation
* Curated features (**Flow** and **Discovery**) powered by the **GROQ LLM API** to build custom playlists from current mood parameters and historical profiles. Includes clean database fallbacks if API keys are absent.

### 4. Playlist Migrator & CSV Parsing
* Drag-and-drop or upload CSV tables containing columns like `title`, `artist`, and `album`.
* Automatically maps search terms against indexed items.
* Displays a details sheet classifying songs into `Matched`, `Duplicates`, and `Missing`.
* Support for importing direct Spotify and YouTube Music links.

### 5. Karaoke Theatre
* Synced `.lrc` lyrics parsing which highlights current sentences in real-time.
* Minimalist fullscreen theatre mode displaying karaoke-style lyric animations.

---

## Database Migration
Strumm includes an automated migration utility that loads the legacy Yuzone JSON files (`json/` directory in the parent workspace), converts string duration structures (e.g. `"5:14"`) into integer seconds, maps legacy user profiles to Strumm structures, and upgrades legacy themes.

**To run the migration:**
Start the FastAPI backend and visit:
```http
GET http://localhost:8000/migration/run
```

---

## Running Locally

### Prerequisites
* **Node.js**: >= 20.0
* **pnpm** or **npx pnpm**
* **Python**: >= 3.11
* **MongoDB**: Atlas Connection URI or Local Server

### 1. Setup Environment Configuration
Copy env templates and populate parameters:
* Frontend: `apps/web/.env.example` to `apps/web/.env.local`
* Backend: `apps/api/.env.example` to `apps/api/.env`

### 2. Initialize Workspaces & Launch
From the root `/strumm` folder:
```bash
# Install dependencies across all workspace modules
npx pnpm install

# Compile and start Next.js frontend in development mode
npx pnpm dev
```

### 3. Launch FastAPI Backend
From `apps/api`:
```bash
# Install Python packages
pip install -r requirements.txt

# Start local server
uvicorn app.main:app --reload
```
The API documentation will be available at `http://localhost:8000/docs`.
