"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { useSession } from "next-auth/react";
import Navigation from "web/components/Navigation";
import { useThemeStore } from "web/store/useThemeStore";
import { usePathname, useRouter } from "next/navigation";
import BrandLogo from "web/components/BrandLogo";
import dynamic from "next/dynamic";
import { isPublicRoute } from "web/lib/routes";

const FriendActivitySidebar = dynamic(() => import("web/components/FriendActivitySidebar"), {
  ssr: false,
});

export default function AuthWrapper({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const { user, token, fetchProfile, login } = useAuthStore();
  const [loading, setLoading] = useState(true);
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

  // Sync NextAuth Google session
  useEffect(() => {
    if (session && (session as any).accessToken && (session as any).user) {
      const currentToken = useAuthStore.getState().token;
      const currentUser = useAuthStore.getState().user;
      if (!currentToken || !currentUser || !currentUser.settings) {
        login((session as any).accessToken, (session as any).user, (session as any).refreshToken);
      }
    }
  }, [session]);

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

  // Redirection guard logic
  useEffect(() => {
    if (!loading) {
      const isAuthenticated = !!user;
      const isPublic = isPublicRoute(pathname);
      if (!isAuthenticated && pathname !== "/login" && pathname !== "/" && !isPublic) {
        const currentSearch = window.location.search;
        router.replace(`/login?redirect=${encodeURIComponent(pathname + currentSearch)}`);
      } else if (isAuthenticated && pathname === "/login") {
        const searchParams = new URLSearchParams(window.location.search);
        const redirectUrl = searchParams.get("redirect") || "/";
        router.replace(redirectUrl);
      }
    }
  }, [user?.id, loading, pathname, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted">
        <BrandLogo size="md" className="animate-pulse mb-3" priority />
        <p className="text-xs uppercase tracking-widest">Opening your music home...</p>
      </div>
    );
  }

  const isAuthenticated = !!user;

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
      className="flex flex-col md:flex-row min-h-screen bg-background text-text relative"
    >
      {customImage && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-[20px] pointer-events-none z-0" />
      )}
      
      {/* Global Sidebar Navigation */}
      <div className="relative z-50 md:z-10">
        <Navigation />
      </div>
      
      {/* Main route contents */}
      <main className={`flex-1 max-w-7xl overflow-y-auto min-h-[calc(100vh-65px)] md:min-h-screen md:ml-64 relative z-10 px-4 pt-4 pb-40 sm:px-6 sm:pt-6 sm:pb-44 md:px-10 md:pt-10 md:pb-48 transition-all duration-300 ${
        isCircleCollapsed ? "xl:mr-16" : "xl:mr-80"
      }`}>
        {children}
      </main>

      {/* Circle activity sidebar */}
      <div className="relative z-10">
        <FriendActivitySidebar
          isCollapsed={isCircleCollapsed}
          onToggleCollapse={() => setIsCircleCollapsed(!isCircleCollapsed)}
        />
      </div>
    </div>
  );
}
