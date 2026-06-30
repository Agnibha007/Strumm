# Strumm Web — Next.js Frontend

## Getting Started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `YOUTUBE_API_KEY` | **Yes** | Google Cloud API key with the YouTube Data API v3 enabled. Used for all song/album/artist search queries. |
| `NEXT_PUBLIC_API_URL` | No | Backend API base URL (defaults to `http://localhost:8000`). |
| `NEXT_PUBLIC_INVIDIOUS_INSTANCE` | No (legacy) | No longer used — search now goes through the YouTube Data API. |

### Obtaining a YouTube API Key

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Navigate to **APIs & Services → Library**.
4. Search for **"YouTube Data API v3"** and enable it.
5. Go to **APIs & Services → Credentials**.
6. Click **Create Credentials → API Key**.
7. Copy the generated key.
8. (Optional) Restrict the key to the YouTube Data API v3 and your Vercel deployment's IP range for security.

### Setting the Key for Production (Vercel)

```bash
vercel env add YOUTUBE_API_KEY
```

Or set it via the Vercel Dashboard: **Project → Settings → Environment Variables**.
