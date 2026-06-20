"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { useSession } from "next-auth/react";
import Navigation from "web/components/Navigation";
import { useThemeStore } from "web/store/useThemeStore";
import { usePathname, useRouter } from "next/navigation";
import BrandLogo from "web/components/BrandLogo";

export default function AuthWrapper({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const { user, token, fetchProfile, login } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const pathname = usePathname();
  const router = useRouter();

  // Sync NextAuth Google session
  useEffect(() => {
    if (session && (session as any).accessToken && (session as any).user) {
      login((session as any).accessToken, (session as any).user);
    }
  }, [session]);

  // Sync profile details
  useEffect(() => {
    const init = async () => {
      if (token) {
        await fetchProfile();
      }
      setLoading(false);
    };
    init();
  }, [token]);

  // Redirection guard logic
  useEffect(() => {
    if (!loading) {
      const isAuthenticated = !!(user && token);
      if (!isAuthenticated && pathname !== "/login" && pathname !== "/") {
        const currentSearch = window.location.search;
        router.replace(`/login?redirect=${encodeURIComponent(pathname + currentSearch)}`);
      } else if (isAuthenticated && pathname === "/login") {
        const searchParams = new URLSearchParams(window.location.search);
        const redirectUrl = searchParams.get("redirect") || "/";
        router.replace(redirectUrl);
      }
    }
  }, [user, token, loading, pathname, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted">
        <BrandLogo size="md" className="animate-pulse mb-3" priority />
        <p className="text-xs uppercase tracking-widest">Opening your music home...</p>
      </div>
    );
  }

  const isAuthenticated = !!(user && token);

  if (!isAuthenticated) {
    if (pathname === "/login" || pathname === "/") {
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
    <div className="flex flex-col md:flex-row min-h-screen bg-background text-text">
      {/* Global Sidebar Navigation */}
      <Navigation />
      
      {/* Main route contents */}
      <main className="flex-1 overflow-y-auto min-h-[calc(100vh-65px)] md:min-h-screen md:ml-64 relative px-4 pt-4 pb-40 sm:px-6 sm:pt-6 sm:pb-44 md:px-10 md:pt-10 md:pb-48">
        {children}
      </main>
    </div>
  );
}
