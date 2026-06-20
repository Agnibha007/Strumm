# Strumm Architecture ⎈

Strumm is structured as a modern monorepo to promote code reusability, easy configuration, and clear separation of concerns.

---

## Workspace Structure
Strumm uses **pnpm workspaces** and **Turborepo** to build its projects:

```text
strumm/
├── apps/
│   ├── web/           # Next.js 15 App Router (Frontend)
│   └── api/           # FastAPI (Python 3.11 backend services)
└── packages/
    ├── types/         # Common TypeScript models & definitions
    ├── ui/            # Reusable UI component libraries
    └── config/        # Global linting and build setups
```

---

## Frontend Architecture (`apps/web`)
* **State Management**: Zustand handles the core player state (`usePlayerStore`), user authentication (`useAuthStore`), and visual themes (`useThemeStore`).
* **Visual Styling**: Vanilla CSS and Tailwind CSS configuration tokens are leveraged for smooth animations, custom themes, and glassmorphism.
* **Component Interactions**:
  * `AudioEngine.tsx`: Controls standard HTML5 `Audio()` objects and YouTube iframe components. It delegates control hooks dynamically to the Zustand store.
  * `VideoPlayer.tsx`: Manages HTML5 `<video>` feeds for podcast video episodes. It automatically registers its playback controls dynamically to override the default audio actions.

---

## Backend Services (`apps/api`)
* **Framework**: FastAPI (Python 3.11+) with asynchronous execution.
* **Database**: MongoDB (via `motor` asynchronous driver).
* **Key Integrations**:
  * **PodcastIndex API**: Standard RSS parsing with enclosure check to differentiate audio and video episodes.
  * **yt-dlp**: Resolves free streaming audio streams for music tracks.
  * **Groq SDK**: Drives LLM-based curation and intelligent playlist generation.
