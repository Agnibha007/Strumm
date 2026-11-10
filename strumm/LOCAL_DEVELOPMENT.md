# Local development and listening-room testing

## Start the API

From `strumm/apps/api`, start the API with development guest authentication explicitly enabled:

```bash
ENVIRONMENT=development STRUMM_DEV_AUTH=true .venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Keep your normal local database configuration in the API environment.

## Start the web app

Set `NEXT_PUBLIC_API_ORIGIN=http://127.0.0.1:8000` in `apps/web/.env.local`, then run from the monorepo root:

```bash
pnpm --filter web dev
```

Open `http://localhost:3000`. In local development, the app creates a guest identity automatically for each browser profile. No sign-in is needed. Use two separate browser profiles to test host and listener behavior.

## Production safety

Guest authentication, its WebSocket token, synthetic guest profiles, and the development rate-limit bypass are accepted only when both `ENVIRONMENT=development` and `STRUMM_DEV_AUTH=true`. Keep `ENVIRONMENT=production` and `STRUMM_DEV_AUTH=false` in deployed environments.
