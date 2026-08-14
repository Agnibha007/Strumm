"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { useSession } from "next-auth/react";
import { useThemeStore } from "web/store/useThemeStore";
import { usePathname, useRouter } from "next/navigation";
import BrandLogo from "web/components/BrandLogo";
import dynamic from "next/dynamic";
import { isPublicRoute } from "web/lib/routes";

const Navigation = dynamic(() => import("web/components/Navigation"), {
  ssr: false,
});

const FriendActivitySidebar = dynamic(() => import("web/components/FriendActivitySidebar"), {
  ssr: false,
});

export default function AuthWrapper({ children }: { children: React.ReactNode }) {
  const { data: session, status: sessionStatus } = useSession();
  const { user, fetchProfile, login } = useAuthStore();
  const [loading, setLoading] = useState(true);
  // One-time latch: NextAuth flips status back to "loading" when it refetches
  // the session on tab focus, which must not re-trigger the splash screen.
  const [sessionResolved, setSessionResolved] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { customImage } = useThemeStore();

  // Circle activity sidebar collapse state
  const [isCircleCollapsed, setIsCircleCollapsed] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("strumm-circle-collapsed") === "true";
    }
    return false;
  });

  useEffect(() => {
    localStorage.setItem("strumm-circle-collapsed", String(isCircleCollapsed));
  }, [isCircleCollapsed]);

  useEffect(() => {
    if (sessionStatus !== "loading") {
      setSessionResolved(true);
    }
  }, [sessionStatus]);

  // Sync NextAuth Google session into the Zustand store.
  // The server-side OAuth sync in the NextAuth route cannot forward the
  // backend's Set-Cookie headers, so after populating the store we also run a
  // browser-side refresh: it establishes the httpOnly access/refresh cookies
  // (so later page reloads restore from cookies instead of the session cookie)
  // and replaces the trimmed session user with the full backend user.
  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    const s = session as any;
    if (!s?.accessToken || !s?.user) return;
    const store = useAuthStore.getState();
    if (store.token && store.user) return;
    login(s.accessToken, s.user, s.refreshToken);
    void useAuthStore.getState().silentRefresh();
  }, [session, sessionStatus, login]);

  // Sync profile details — auth is via httpOnly cookie, so we don't need token
  useEffect(() => {
    const init = async () => {
      if (user) {
        await fetchProfile();
      }
      setLoading(false);
    };
    init();
  }, [user?.id]);

  // Redirection guard logic. Never redirect while NextAuth is still resolving:
  // a Google OAuth session restores the store from the session cookie, so
  // redirecting early would flash the login page and bounce the user back.
  useEffect(() => {
    if (loading) return;
    if (!sessionResolved) return;
    const hasSessionCreds =
      sessionStatus === "authenticated" &&
      !!(session as any)?.accessToken &&
      !!(session as any)?.user;
    const isAuthenticated = !!user || hasSessionCreds;
    const isPublic = isPublicRoute(pathname);
    if (!isAuthenticated && pathname !== "/login" && pathname !== "/" && !isPublic) {
      const currentSearch = window.location.search;
      router.replace(`/login?redirect=${encodeURIComponent(pathname + currentSearch)}`);
    } else if (isAuthenticated && pathname === "/login") {
      const searchParams = new URLSearchParams(window.location.search);
      const redirectUrl = searchParams.get("redirect") || "/";
      router.replace(redirectUrl);
    }
  }, [user?.id, loading, pathname, router, sessionStatus, session, sessionResolved]);

  if (loading || !sessionResolved) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted">
        <BrandLogo size="md" className="animate-pulse mb-3" priority />
        <p className="text-xs uppercase tracking-widest">Opening your music home...</p>
      </div>
    );
  }

  const isAuthenticated = !!user || (sessionStatus === "authenticated" && !!(session as any)?.accessToken && !!(session as any)?.user);

  if (!isAuthenticated) {
    if (pathname === "/login" || pathname === "/" || isPublicRoute(pathname)) {
      return <>{children}</>;
    }
    
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted">
        <BrandLogo size="md" className="animate-pulse mb-3" priority />
        <p className="text-xs uppercase tracking-widest">Redirecting to login...</p>
      </div>
    );
  }

  if (pathname === "/login") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted">
        <BrandLogo size="md" className="animate-pulse mb-3" priority />
        <p className="text-xs uppercase tracking-widest">Redirecting to home...</p>
      </div>
    );
  }

  return (
    <div
      style={
        customImage
          ? { backgroundImage: `url(${customImage})`, backgroundSize: "cover", backgroundPosition: "center", backgroundAttachment: "fixed" }
          : undefined
      }
      className="min-h-screen bg-background text-text relative"
    >
      {customImage && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-[20px] pointer-events-none z-0" />
      )}
      
      {/* Global Sidebar Navigation */}
      <Navigation />
      
      {/* Main route contents */}
      <main id="main-content" tabIndex={-1} className={`min-h-screen md:ml-64 outline-none relative z-10 px-4 pt-14 pb-40 sm:px-6 sm:pt-16 sm:pb-44 md:pl-6 md:pr-6 md:pt-10 md:pb-48 transition-all duration-300 ${
        isCircleCollapsed ? "xl:mr-16" : "xl:mr-80"
      }`}>
        {children}
      </main>

      {/* Circle activity sidebar */}
      <FriendActivitySidebar
        isCollapsed={isCircleCollapsed}
        onToggleCollapse={() => setIsCircleCollapsed(!isCircleCollapsed)}
      />
    </div>
  );
}
