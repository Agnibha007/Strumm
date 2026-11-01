"use client";

/**
 * JsonLdList — Renders multiple schema.org JSON-LD script tags from an array
 * of schema objects. Used by client-rendered pages (e.g. /replay, /search) where
 * the schemas are derived from client-side state and therefore cannot be passed
 * from a server component directly.
 *
 * Every script carries the per-request CSP nonce provided by StrummNonceProvider
 * so the strict nonce-based Content Security Policy (see src/middleware.ts) does
 * not block them.
 */
import { useStrummNonce } from "web/components/StrummNonceContext";

export default function JsonLdList({
  schemas,
}: {
  schemas: Record<string, unknown>[];
}) {
  const nonce = useStrummNonce();

  if (!schemas || schemas.length === 0) return null;

  return (
    <>
      {schemas.map((schema, i) => (
        <script
          key={i}
          type="application/ld+json"
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
        />
      ))}
    </>
  );
}
