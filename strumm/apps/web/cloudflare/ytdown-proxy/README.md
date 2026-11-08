# Strumm browser download proxy

The browser performs YouTube extraction with the `@4thel00z/ytdown` WebAssembly SDK and stores the downloaded audio in IndexedDB. This Worker is only the CORS bridge required because YouTube and GoogleVideo do not expose the responses to browser JavaScript directly. It does not extract, convert, or store media.

## Deploy

1. Install Wrangler and authenticate with the Cloudflare account that owns the Worker.
2. From this directory, run `npx wrangler deploy`.
3. Copy the generated `workers.dev` URL.
4. Set `NEXT_PUBLIC_YTDOWN_PROXY_URL` to that URL in the Strumm web deployment environment.
5. Redeploy the web app so the browser bundle and Content Security Policy include the Worker origin.

The default origin allowlist contains the Strumm production domains and local development on port 3000. Add any additional trusted preview origin to `ALLOWED_ORIGINS` before deploying.

## Local development

Run `npx wrangler dev --local --ip 127.0.0.1 --port 8787`, then set `NEXT_PUBLIC_YTDOWN_PROXY_URL=http://localhost:8787` for the web app.

## Security boundary

The Worker only forwards HTTPS requests to YouTube, YouTube NoCookie, and GoogleVideo hostnames. Redirects are revalidated before they are followed. Browser origins are allowlisted, and upstream response headers are restricted to the media headers Strumm needs.

The origin check is a browser CORS boundary, not authentication: non-browser clients can spoof an Origin header. Keep the target-host allowlist narrow and monitor Worker usage. Do not turn this into a general-purpose URL proxy.
