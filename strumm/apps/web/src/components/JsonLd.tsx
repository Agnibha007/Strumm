/**
 * JsonLd — Renders a schema.org JSON-LD script tag that complies with the
 * nonce-based Content Security Policy enforced in `src/middleware.ts`.
 *
 * The middleware issues a per-request CSP nonce via the `x-nonce` request
 * header and sets a matching `Content-Security-Policy` header. Next.js applies
 * that nonce to its own bootstrap scripts automatically, but any inline script
 * we render ourselves must carry the nonce explicitly or the browser blocks it
 * (script-src 'self' 'nonce-…' without 'unsafe-inline').
 *
 * Usage (in server components):
 *   const schema = { "@context": "https://schema.org", "@type": "AboutPage", ... };
 *   <JsonLd schema={schema} />
 */
import { headers } from "next/headers";

export default async function JsonLd({
  schema,
}: {
  schema: Record<string, unknown>;
}) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(schema),
      }}
    />
  );
}
