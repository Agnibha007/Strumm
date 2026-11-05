# HOKAS deployment profile

This is a constrained staging profile for HOKAS's free Python runtime. It is not a replacement for the full Hugging Face deployment.

## HOKAS free-tier constraints

HOKAS currently lists 0.3 vCPU, 256 MB RAM and 512 MB disk for its free plan. Free servers have a limited uptime allowance that must be extended through the HOKAS ad/link flow; the free plan has no uptime SLA. Resource and uptime limits can change. Keep Hugging Face as the primary deployment until the HOKAS instance has been tested under real traffic.

## Features in this profile

The profile keeps the account, user, playlist/library, metadata discovery, lyrics, social, feedback, collaboration, room/WebSocket and media-metadata APIs.

The following routes are intentionally unavailable in this profile:

- Direct audio proxy and playback routes (`/resolve/*`, `/play/*`, `/audio-proxy`, `/podcast-audio`).
- YouTube stream resolution (`/yt/streams/*`).
- Audius track streaming (`/audius/tracks/*/stream`).
- Podcast episode downloads (`/podcasts/episode/*/download`).
- Song downloads (`/downloads/song`).

Do not enable or proxy copyrighted audio on HOKAS unless you have the rights or authorization required for that content. The HOKAS profile is deliberately restricted to avoid deploying the media delivery paths on its free plan.

## Create the HOKAS server

1. Create a HOKAS account. Its current terms allow free accounts from age 13; paid plans require age 18.
2. Choose **Deploy New Server**, select **Python**, and choose **Free**.
3. Use the GitHub deployment option if it is available in the dashboard and select the `deploy/hokas-free-profile` branch of `Agnibha007/Strumm`. Otherwise upload/clone the repository using the HOKAS terminal/file tools.
4. In the HOKAS terminal, locate the repository checkout and enter `strumm/apps/api`.
5. Install the HOKAS runtime dependencies:

   ```sh
   python -m pip install --no-cache-dir -r requirements-hokas.txt
   ```

6. Set the server's startup command to:

   ```sh
   sh strumm/apps/api/hokas_start.sh
   ```

   If the panel's working directory is already `strumm/apps/api`, use `sh hokas_start.sh` instead.

## Environment variables

Set these in the HOKAS server's environment/settings page. Never commit secret values to GitHub.

Required for the normal authenticated API:

- `MONGODB_URI`: the existing MongoDB Atlas connection string.
- `JWT_SECRET`: the existing production JWT signing secret.
- `ENVIRONMENT=production`
- `STRUMM_APP_URL=https://strumm.me`
- `ALLOWED_ORIGINS=https://strumm.me,https://www.strumm.me`
- `HOKAS_PROFILE=1`

For user media metadata and B2-backed avatars, also configure:

- `B2_ENDPOINT=https://s3.eu-central-003.backblazeb2.com`
- `B2_REGION=eu-central-003`
- `B2_BUCKET_NAME=strumm-media-prod`
- `B2_KEY_ID`
- `B2_APPLICATION_KEY`

Configure the email provider variables (`RESEND_API_KEY` and `SENDER_FROM`, or the SMTP settings) if email OTP/password flows are required. Other integrations such as Google OAuth and AI require their respective credentials.

The existing MongoDB database is expected to already have the application's indexes from the primary deployment. This low-resource profile skips the full database-wide index and legacy-room initialization at startup.

**Database isolation warning:** `app/database/mongodb.py` currently fixes the database name to `strumm`. The HOKAS profile therefore reads and writes the same `strumm` database as the primary deployment when given the same MongoDB URI. Use a dedicated test account and test records only. Do not run destructive tests or point the production frontend at this HOKAS instance.

## Verify the deployment

Replace `<hokas-host>` with the subdomain assigned by HOKAS:

```sh
curl -i https://<hokas-host>/health
curl -i https://<hokas-host>/health/db
```

Expected liveness response:

```json
{"status":"healthy"}
```

The media routes listed above deliberately return HTTP 501 in this profile. The standard Hugging Face deployment is unchanged and continues to expose the full feature set.

## Rollback

Stop the HOKAS server or remove its `HOKAS_PROFILE` environment variable. Do not point the production frontend at this instance until login, database connectivity, WebSockets and the intended feature subset have been verified. The Hugging Face deployment and its Dockerfile are not changed by this profile.
