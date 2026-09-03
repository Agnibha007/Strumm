# Strumm Infrastructure

> Deployment notes, environment configuration, and operational reference for the Strumm music ecosystem.

---

## 1. Project Overview

- **Monorepo:** Turborepo + pnpm workspaces
- **Backend:** Python 3.11 / FastAPI (app in `apps/api/`)
- **Frontend:** Next.js 15.5 / React 19.1 (app in `apps/web/`)
- **Database:** MongoDB (async via Motor driver)
- **Auth:** JWT (access + refresh tokens) + Google OAuth (NextAuth.js)
- **Container:** Docker (Python slim image)
- **Hosts:** Render (API), Hugging Face Spaces (API), Vercel-compatible (frontend)

---

## 2. Prerequisites

| Tool     | Version       |
|----------|---------------|
| Node.js  | >= 20.0.0     |
| pnpm     | 11.8.0        |
| Python   | 3.11+         |
| MongoDB  | 6.0+ (Atlas or local) |

Install pnpm:

```bash
npm install -g pnpm@11.8.0
```

---

## 3. Local Development

### 3.1 Install dependencies

```bash
pnpm install
```

### 3.2 Environment variables

Copy the template and fill in values:

```bash
# Backend — create apps/api/.env
MONGODB_URI=mongodb+srv://...
JWT_SECRET=...
ENVIRONMENT=development
STRUMM_APP_URL=http://localhost:3000
ALLOWED_ORIGINS=http://localhost:3000
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SMTP_SERVER=...
SENDER_EMAIL=...
SENDER_PASSWORD=...
RESEND_API_KEY=...
SENDER_FROM=noreply@strumm.me

# Frontend — create apps/web/.env.local
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=...
AUTH_GOOGLE_ID=...
AUTH_GOOGLE_SECRET=...
```

### 3.3 Start dev servers

```bash
# Start both API + web
pnpm dev

# Or individually:
pnpm --filter web dev       # Next.js on :3000
cd apps/api && uvicorn app.main:app --reload  # FastAPI on :8000
```

### 3.4 Database indexes

Indexes are created automatically on startup via `_create_indexes()` in `main.py`. No manual setup needed.

---

## 4. Environment Variables

### 4.1 Backend (`apps/api/`)

| Variable                | Required  | Description                                    |
|-------------------------|-----------|------------------------------------------------|
| `MONGODB_URI`           | ✅        | MongoDB connection string                      |
| `JWT_SECRET`            | ✅        | Secret key for JWT signing                     |
| `ENVIRONMENT`           | ✅        | `development` or `production`                  |
| `STRUMM_APP_URL`        | ✅        | Frontend origin (e.g. `https://strumm.me`)     |
| `ALLOWED_ORIGINS`       | ✅        | Comma-separated CORS origins                   |
| `GOOGLE_CLIENT_ID`      | ✅        | Google OAuth client ID                         |
| `GOOGLE_CLIENT_SECRET`  | ✅        | Google OAuth client secret                     |
| `SMTP_SERVER`           | Optional  | SMTP host for transactional emails             |
| `SENDER_EMAIL`          | Optional  | SMTP sender address                            |
| `SENDER_PASSWORD`       | Optional  | SMTP password/app-password                     |
| `RESEND_API_KEY`        | Optional  | Resend.com API key (alternative to SMTP)       |
| `SENDER_FROM`           | Optional  | From address for Resend                        |
| `EXPOSE_DEV_OTP`        | Optional  | Expose OTP in dev responses for testing        |
| `DNS_NAMESERVERS`       | Optional  | Custom DNS resolvers (default: `1.1.1.1,8.8.8.8`) |
| `MIGRATION_JSON_DIR`    | Optional  | Path to legacy data JSON files for migration   |
| `B2_ENDPOINT`           | Optional  | Backblaze B2 S3 endpoint (`https://s3.eu-central-003.backblazeb2.com`) |
| `B2_REGION`             | Optional  | Backblaze B2 region (`eu-central-003`)          |
| `B2_BUCKET_NAME`        | Optional  | Backblaze B2 bucket (e.g. `strumm-media-prod`)  |
| `B2_KEY_ID`             | Optional  | Backblaze application key ID (secret)           |
| `B2_APPLICATION_KEY`    | Optional  | Backblaze application key secret (secret)       |

### 4.2 Frontend (`apps/web/`)

| Variable                | Required  | Description                                      |
|-------------------------|-----------|--------------------------------------------------|
| `NEXT_PUBLIC_APP_URL`   | ✅        | Frontend URL (e.g. `https://strumm.me`)          |
| `NEXT_PUBLIC_API_URL`   | ✅        | Backend API URL (e.g. `https://api.strumm.me`)   |
| `NEXT_PUBLIC_API_BASE_URL` | ⬅️  | Alias for above (either works)                   |
| `NEXTAUTH_URL`          | ✅        | NextAuth callback URL                            |
| `NEXTAUTH_SECRET`        | ✅        | NextAuth encryption secret                       |
| `AUTH_GOOGLE_ID`        | ✅        | Google OAuth client ID (for NextAuth)            |
| `AUTH_GOOGLE_SECRET`    | ✅        | Google OAuth client secret (for NextAuth)        |

---

## 5. MongoDB Collections

All collection name constants are defined in `apps/api/app/database/mongodb.py`.

| Collection              | Purpose                                              |
|-------------------------|------------------------------------------------------|
| `users`                 | User accounts, settings, statistics, badges          |
| `playlists`             | User-created playlists with embedded song arrays     |
| `likedsongs`            | Liked song references per user                       |
| `playbackhistories`     | Per-play-event records (song, listenDuration, time)  |
| `playerstates`          | Saved player state for cross-device sync             |
| `shares`                | Share tokens for playlists (TTL index)               |
| `podcastshows`          | Podcast show metadata (RSS-sourced)                  |
| `podcastepisodes`       | Individual podcast episodes                          |
| `connections`           | Friend/circle connection requests                    |
| `activities`            | Real-time listening activity (TTL index)             |
| `rooms`                 | Collaborative listening rooms                        |
| `notifications`         | User notifications                                  |
| `sessions`              | Auth session tokens (refresh token persistence)      |
| `lyrics_cache`          | Cached lyrics data (TTL-managed in-app)              |
| `songMemories`          | User song memories/notes                             |
| `follows`               | Content follows (artists, playlists)                 |
| `media`                 | Object-storage (B2) records — object key, owner, status |

### 5.1 Object Storage — Backblaze B2

Strumm stores user-uploaded media in a **private** Backblaze B2 bucket using the
**S3-compatible** API (MinIO client). The backend never exposes the B2
application key to the frontend — it only issues short-lived **presigned**
URLs.

**Service:** `apps/api/app/services/storage.py` — the only module that knows
about B2/S3. It exposes:

- `create_upload_url(...)` → presigned PUT URL + object key (direct upload)
- `create_download_url(...)` → presigned GET URL (private download/playback)
- `delete_object(object_key)` → authorized delete (respects versioning)
- `object_exists(object_key)` → existence check

**Routes:** `apps/api/app/routes/media.py`

| Endpoint               | Method | Auth | Purpose                                          |
|------------------------|--------|------|--------------------------------------------------|
| `/media/upload-url`    | POST   | ✅   | Validate + issue presigned PUT URL, persist record |
| `/media/confirm`       | POST   | ✅   | Mark a just-uploaded record as `ready`           |
| `/media/download-url`  | GET    | ✅   | Authorize ownership + issue short-lived GET URL  |
| `/media/`              | DELETE | ✅   | Authorize + delete an owned object               |

**Object-key structure** (sanitized, collision-resistant unique segment):

```
users/{ownerId}/avatar/{uuid}-{filename}      # avatars
media/{ownerId}/{mediaId}/{uuid}-{filename}   # images / general media
audio/{ownerId}/{mediaId}/{uuid}-{filename}   # audio
```

**B2 bucket configuration** (must be set manually in the Backblaze dashboard):

1. Bucket is **private** (`strumm-media-prod`), encryption SSE-B2, versioning
   "Keep all versions". The backend soft-deletes (`deletedAt`) while the bucket
   retains version history.
2. Create an **application key** with access limited to this bucket (not a
   master key). Set `B2_KEY_ID` / `B2_APPLICATION_KEY` server-side only.
3. **CORS** on the bucket (S3-compatible) so browsers can upload directly and
   fetch private media. In the Backblaze dashboard, set the bucket CORS rules to:

```json
[
  {
    "corsRuleName": "StrummWeb",
    "allowedOrigins": [
      "https://strumm.me",
      "https://www.strumm.me",
      "http://localhost:3000",
      "http://localhost:5173"
    ],
    "allowedHeaders": ["*"],
    "allowedMethods": ["GET", "HEAD", "PUT"],
    "exposeHeaders": ["ETag", "Content-Length", "Content-Type"],
    "maxAgeSeconds": 3600
  }
]
```

Presigned GET URLs honor HTTP Range requests, so video/audio playback works
directly from the bucket without proxying bytes through the backend.

---

## 6. Deployment

### 6.1 Backend — Render (primary)

**Service type:** Web Service (Docker)

**Config:** `apps/api/render.yaml`

| Setting          | Value            |
|------------------|------------------|
| Runtime          | Docker           |
| Dockerfile       | `apps/api/Dockerfile` |
| Health check     | `/health`        |
| Port             | `7860` (overridden by `$PORT`) |

**Steps:**

1. Connect Render to the GitHub repo
2. Set `Root Directory` to `apps/api` (or use the render.yaml blueprint)
3. Add all required env vars from §4.1 (mark secrets as "synced: false")
4. Deploy — Render builds the Docker image and starts Uvicorn

### 6.2 Backend — Hugging Face Spaces (secondary)

**Config:** `.github/workflows/deploy-hf.yml` + `apps/api/README.md` (HF metadata)

The workflow syncs `apps/api/` to a HF Space on every push to `master`. The Space uses Docker SDK (`sdk: docker`). Secrets are set via HF Space secrets UI.

### 6.3 Frontend — Next.js

Suitable for Vercel, Netlify, or any Node.js host.

**Build command:** `pnpm build` (runs `turbo run build`)

**Output directory:** `apps/web/.next`

**Steps:**

1. Set root directory to `apps/web`
2. Add all frontend env vars from §4.2
3. Build command: `pnpm install && pnpm build`
4. Start command: `cd apps/web && npx next start`

> CSP headers are configured in `next.config.ts` via `async headers()`. Make sure your hosting platform supports custom headers.

---

## 7. CI/CD

### 7.1 CI — GitHub Actions (`.github/workflows/ci.yml`)

Triggers on push/PR to `master`. Runs:
- Lint (ESLint via `turbo run lint`)
- TypeScript type check (`tsc --noEmit`)

### 7.2 Deploy HF — GitHub Actions (`.github/workflows/deploy-hf.yml`)

Triggers on push to `master`. Syncs `apps/api/` to Hugging Face Spaces.

Required secrets:
- `HF_TOKEN` — HF access token with write permissions
- `HF_SPACE_NAME` — Space identifier (e.g. `username/strumm-api`)

---

## 8. Docker

### 8.1 Build locally

```bash
cd apps/api
docker build -t strumm-api .
docker run -p 7860:7860 \
  -e MONGODB_URI=... \
  -e JWT_SECRET=... \
  strumm-api
```

### 8.2 Image details

- **Base:** `python:3.11-slim-bullseye`
- **Extra packages:** `ca-certificates`, `openssl` (for SSL/TLS YouTube Music API calls)
- **Server:** Uvicorn with 1 worker, 64 concurrent connections
- **Port:** 7860 (Render/HF default; overridable via `$PORT`)

---

## 9. Domain & DNS

- **Main site:** `https://strumm.me`
- **Backend API:** served from the same Render/HF domain
- **DNS nameservers:** Custom resolvers configurable via `DNS_NAMESERVERS` env var (default: Cloudflare 1.1.1.1 + Google 8.8.8.8)
- **CORS:** Backend automatically allows `strumm.me`, `www.strumm.me`, and localhost origins

### 9.1 CORS origins

The backend dynamically computes allowed origins from:
1. `ALLOWED_ORIGINS` env var
2. `STRUMM_APP_URL` env var
3. Production defaults (`https://strumm.me`, `https://www.strumm.me`)
4. Auto-added `www.` or bare variant of STRUMM_APP_URL

---

## 10. Service Integrations

| Service     | Purpose                              | Required |
|-------------|--------------------------------------|----------|
| MongoDB Atlas | Primary database                   | ✅       |
| Google OAuth | Social login via NextAuth.js       | ✅       |
| YouTube Data | Music streaming & metadata (iframe API) | ✅ |
| Resend       | Transactional emails (fallback: SMTP) | Optional |
| Render       | API hosting                          | ✅       |
| Hugging Face | Secondary API deployment             | Optional |
| GitHub Pages | Wiki (or in-repo markdown)          | Optional |

---

## 11. Sitemap & SEO

- **Sitemap:** Generated at build time by `apps/web/src/app/sitemap.ts`
  - Fetches dynamic entries from `BACKEND_URL/sitemap` endpoint
  - Falls back to known static routes if backend is unreachable
- **Robots:** Generated by `apps/web/src/app/robots.ts`
  - Disallows: `/api/`, `/_next/`, `/settings/`, `/profile/`
- **Metadata:** Individual pages use `generateMetadata` with per-page OG/Twitter cards:
  - `/song/[id]` — title, artist
  - `/playlist/[id]` — name, song count
  - `/podcasts/show/[id]` — show title, description
  - `/podcast/[id]` — episode title, show name
  - `/public/[username]` — display name

---

## 12. PWA

- **Service worker:** `apps/web/public/sw.js` — caches shell assets, excludes media/stream URLs
- **Manifest:** Generated by `apps/web/src/app/manifest.ts`
- **Install prompt:** `AddToHomePrompt` component

---

## 13. Rate Limiting

The API uses an in-memory LRU rate limiter (defined in `main.py`):

| Setting         | Default |
|-----------------|---------|
| Max requests    | 100     |
| Window          | 10 seconds |
| Max clients     | 500     |

---

## 14. Background Tasks

### 14.1 Active

- **Sound DNA recalculation** — runs after every play-event (`POST /play-event`) via fire-and-forget `asyncio.create_task()`. Rebuilds soundDNA, topSongs, topArtists from raw histories and saves to user document.
- **MongoDB index creation** — runs once on startup.

### 14.2 Removed (archived)

- **`daily_stats_refresher`** — previously recalculated stats for ALL users every 24 hours. Replaced by per-play-event live recalculation.

---

## 15. Health Checks

| Endpoint       | Method | Purpose                          |
|----------------|--------|----------------------------------|
| `/`            | GET    | Root probe (used by Render/HF)   |
| `/health`      | GET/HEAD | Lightweight liveness check (no DB) |
| `/health/db`   | GET    | Detailed health with DB probe    |
| `/health/disk` | GET    | Disk usage (Render 512MB limit)  |

---

## 16. Migration

**Endpoint:** `POST /migration/run` (admin-only)

Imports legacy data from JSON files. The path is configured by the `MIGRATION_JSON_DIR` env var.

```bash
curl -X POST https://api.strumm.me/migration/run \
  -H "Authorization: Bearer <admin-token>"
```

---

## 17. Scripts

No shell/scripts directory exists yet. Common operations:

```bash
# Rebuild all
pnpm build

# Type-check backend
cd apps/api && mypy app/

# Type-check frontend
cd apps/web && npx tsc --noEmit

# Lint
pnpm lint
```
