"use client";

import { useAuthStore } from "web/store/useAuthStore";

/**
 * Client wrapper that conditionally applies the sidebar offset (md:ml-64)
 * so the login page (which has no sidebar) isn't shifted right on desktop.
 */
export default function ContentWrapper({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  const sidebarOffset = user ? "md:ml-64" : "";

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={`outline-none flex-1 pt-14 md:pt-0 transition-all duration-300 ${sidebarOffset}`}
    >
      {children}
    </main>
  );
}
