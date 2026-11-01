"use client";

/**
 * StrummNonceContext — Client-side access to the per-request CSP nonce that
 * the server middleware generates and the root layout provides. Client-rendered
 * inline scripts (e.g. JSON-LD emitted from "use client" pages such as /replay
 * and /search) must carry this same nonce or the strict Content Security Policy
 * blocks them.
 */
import { createContext, useContext } from "react";

const StrummNonceContext = createContext<string | undefined>(undefined);

export function StrummNonceProvider({
  nonce,
  children,
}: {
  nonce?: string;
  children: React.ReactNode;
}) {
  return (
    <StrummNonceContext.Provider value={nonce}>{children}</StrummNonceContext.Provider>
  );
}

export function useStrummNonce(): string | undefined {
  return useContext(StrummNonceContext);
}
