# Strumm API on blitz.cloud

This branch adds a root-level Dockerfile for deploying the **full Strumm FastAPI backend** from this monorepo. It does not replace or modify the Hugging Face deployment.

## Build layout

- Select the repository-root `/Dockerfile` in blitz.cloud.
- The Docker build reads the full API runtime dependencies from `strumm/apps/api/requirements.txt`.
- It copies only `strumm/apps/api/app/` into the runtime image.
- The image includes FFmpeg and Deno for the existing media-resolution toolchain.
- The app listens on `0.0.0.0:8080` by default and honours blitz.cloud's `PORT` variable.
- The image explicitly sets `HOKAS_PROFILE=0`. Do not override it to `1`.
- Leave the dashboard's Start command empty/default so the Dockerfile's `CMD` is used.
- Do not select `strumm/apps/api/Dockerfile`; that existing Dockerfile is for the Hugging Face/API-directory build context.

The container runs as the unprivileged `strumm` user. It uses one Uvicorn worker so startup tasks and background cleanup are not duplicated.

## blitz.cloud free-plan limitation

The free plan is suitable for an experimental deployment, not as the only production API endpoint:

- An addressed app sleeps after 15 minutes without a browser visit.
- Requests from API clients, scripts, webhooks and uptime monitors do not wake a sleeping app.
- The free plan has 512 MB of reserved memory shared across the account and 10 GB of storage.
- App filesystem data is discarded on restart unless a folder is explicitly kept; free-plan kept folders are not backed up.

Keep the existing Hugging Face API as the production endpoint. Do not point the Strumm frontend at this free Blitz deployment as a permanent replacement. Use Blitz to test its build, API startup, MongoDB connection and outbound media connectivity while the app is awake.

## Environment variables

Add these in the app's Environment tab. Never commit their values to Git.

### Required

- `MONGODB_URI`
- `JWT_SECRET` (at least 32 characters)
- `ENVIRONMENT=production`
- `STRUMM_APP_URL=https://strumm.me`
- `ALLOWED_ORIGINS=https://strumm.me,https://www.strumm.me`

The platform supplies `PORT`; the container defaults to 8080 when it is absent. Do not set `HOKAS_PROFILE=1`.

### Backblaze B2

Needed for B2-backed avatar/media operations:

- `B2_ENDPOINT=https://s3.eu-central-003.backblazeb2.com`
- `B2_REGION=eu-central-003`
- `B2_BUCKET_NAME=strumm-media-prod`
- `B2_KEY_ID`
- `B2_APPLICATION_KEY`

Use a bucket-scoped B2 application key.

### Optional integrations

- AI: `GROQ_API_KEY`
- Email via Resend: `RESEND_API_KEY` and optionally `SENDER_FROM`
- Email via SMTP instead: `SMTP_SERVER`, `SMTP_PORT`, `SENDER_EMAIL`, `SENDER_PASSWORD`
- Monitoring: `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`
- Frontend links in emails: `FRONTEND_URL=https://strumm.me`

Environment changes take effect after restarting the app.

### YouTube yt-dlp cookies (optional)

The API supports a browser-exported YouTube cookie JSON file for yt-dlp extraction and authorized song downloads:

- `YTDLP_COOKIES_JSON_B64`: Base64-encoded JSON cookie export (raw or gzip-compressed), stored as a secret environment variable in Blitz.
- `YTDLP_COOKIES_FILE`: alternatively, a mounted Netscape-format cookie file or browser-exported JSON file path. Use only if the platform provides a private secret-file mount.

For the current local export, copy its encoded value to the clipboard without printing it into a terminal transcript:

```sh
cd ~/Desktop/Strumm
gzip -9c .secrets/youtube/cookie.json | base64 -w0 | wl-copy
```

Create `YTDLP_COOKIES_JSON_B64` in Blitz's Environment tab, mark it as a secret if the dashboard offers that option, paste the clipboard value, and restart the app. The compressed value is much shorter than plain Base64. The API detects gzip automatically, decompresses the JSON export, filters it to YouTube domains, converts it to Netscape format at runtime, and writes the temporary cookie file with owner-only permissions. Raw (uncompressed) Base64 remains supported too. Cookie values are never logged, copied into the Docker image, or committed to Git. Refresh the secret whenever the browser export expires or is rotated; each environment update requires an app restart.

The cookie export is an account credential. Keep it private and use the download endpoint only for media you own or have permission to download. A valid cookie does not guarantee YouTube will serve every cloud-hosted request; cloud egress/IP challenges and provider availability can still prevent extraction.

## Database safety

The API currently fixes its MongoDB database name to `strumm` in `app/database/mongodb.py`; a database name appended to the URI does not select a different database in this code. Use a separate MongoDB Atlas cluster for deployment tests.

The full profile runs database index/legacy initialization and the media cleanup loop in the background after startup. Do not test this branch against production data until you have deliberately planned the cutover and backup.

## Deploy steps

1. In blitz.cloud, choose **Host something new** → **My own code**.
2. Select or paste `https://github.com/Agnibha007/Strumm`.
3. Select branch `deploy/blitz-cloud`.
4. In Advanced settings, select the repository-root `/Dockerfile`.
5. Keep the Dockerfile's default start command; do not enter `hokas_start.sh` or a HOKAS command.
6. Name the app (for example, `strumm-api-test`) and start the build.
7. Add the environment variables above in the app's Environment tab, then restart if the app was already started.
8. Open the assigned `https://<app-name>.<your-address>.prod.page/health` URL in a browser once to wake the free-plan app.
9. While it is awake, verify the API and database health endpoints:

   ```sh
   curl -i https://<app-host>/health
   curl -i https://<app-host>/health/db
   ```

Expected liveness response: HTTP 200 with `{"status":"healthy"}`.

## Deployment boundaries

- Hugging Face's existing Dockerfile and deployment are unchanged.
- The HOKAS deployment branch and startup script are unchanged.
- This Dockerfile is selected only by the new `deploy/blitz-cloud` branch.
- Keep the frontend pointed at the existing API until the Blitz build, startup, database and media tests have all passed. The free-plan sleep behaviour still prevents a reliable production cutover.
