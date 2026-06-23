"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthStore } from "web/store/useAuthStore";
import { signOut } from "next-auth/react";
import { Home, Library, ListMusic, Settings, LogOut, User as UserIcon, Search, Radio, Menu, X, Sparkles, Users, Tv } from "lucide-react";
import BrandLogo from "web/components/BrandLogo";
import { AnimatePresence, motion } from "framer-motion";

export default function Navigation() {
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const [isOpen, setIsOpen] = useState(false);

  const navItems = [
    { label: "Home", href: "/", icon: Home },
    { label: "Strumm Flow", href: "/flow", icon: Sparkles },
    { label: "Search", href: "/search", icon: Search },
    { label: "Library", href: "/library", icon: Library },
    { label: "Playlists", href: "/playlists", icon: ListMusic },
    { label: "Podcasts", href: "/podcasts", icon: Radio },
    { label: "Circle", href: "/circle", icon: Users },
    { label: "Rooms", href: "/rooms", icon: Tv },
    { label: "Replay", href: "/replay", icon: Sparkles },
    { label: "Profile", href: "/profile", icon: UserIcon },
    { label: "Settings", href: "/settings", icon: Settings },
  ];

  const handleLogout = () => {
    logout();
    signOut();
  };

  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  useEffect(() => {
    let touchStartX = 0;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartX = e.touches[0].clientX;
    };
    const handleTouchEnd = (e: TouchEvent) => {
      const touchEndX = e.changedTouches[0].clientX;
      if (touchEndX - touchStartX > 80 && touchStartX < 50) {
        setIsOpen(true);
      }
    };
    
    if (typeof window !== "undefined") {
      window.addEventListener("touchstart", handleTouchStart);
      window.addEventListener("touchend", handleTouchEnd);
    }
    
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("touchstart", handleTouchStart);
        window.removeEventListener("touchend", handleTouchEnd);
      }
    };
  }, []);

  const navContent = (
    <>
      <div className="p-6 flex-grow overflow-y-auto min-h-0 scrollbar-none">
        <div className="mb-8 flex items-start justify-between gap-3">
          <div>
            <Link href="/" className="inline-flex items-center gap-3 hover:opacity-90 transition">
              <BrandLogo variant="mark" size="sm" priority />
              <span className="text-2xl font-editorial text-text tracking-tight font-bold leading-none">
                strumm~
              </span>
            </Link>
            <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block mt-2 ml-12">
              Where your music lives.
            </span>
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="md:hidden p-2 text-muted hover:text-text hover:bg-surface-elevated rounded-lg transition"
            title="Close navigation"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="space-y-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;
            return (
              <Link key={item.href} href={item.href}>
                <span
                  className={`flex items-center gap-3.5 px-4 py-3 rounded-lg text-sm font-semibold transition cursor-pointer select-none ${
                    isActive
                      ? "bg-primary/10 text-primary font-bold border border-primary/20"
                      : "text-muted hover:text-text hover:bg-surface-elevated/40 border border-transparent"
                  }`}
                >
                  <Icon className={`w-4.5 h-4.5 ${isActive ? "text-primary" : "text-muted"}`} />
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>
      </div>

      {user && (
        <div className="p-4 border-t border-border/40 bg-surface/30 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {user.avatar ? (
              <img src={user.avatar} loading="lazy" decoding="async" className="w-8 h-8 rounded-full object-cover shadow border border-border/40" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-surface-elevated border border-border flex items-center justify-center">
                <UserIcon className="w-4 h-4 text-accent" />
              </div>
            )}
            <div className="text-left min-w-0">
              <div className="text-xs font-bold text-text truncate leading-tight">{user.displayName}</div>
              <div className="text-[9px] text-muted truncate">@{user.username}</div>
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="p-1.5 hover:bg-surface-elevated text-primary rounded cursor-pointer transition"
            title="Sign out session"
          >
            <LogOut className="w-4.5 h-4.5" />
          </button>
        </div>
      )}
    </>
  );

  return (
    <>
      <header className="md:hidden sticky top-0 z-40 bg-surface/90 backdrop-blur-xl border-b border-border/60 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => setIsOpen(true)}
          className="p-2 -ml-2 text-muted hover:text-text hover:bg-surface-elevated rounded-lg transition flex-shrink-0"
          title="Open navigation"
        >
          <Menu className="w-5 h-5" />
        </button>
        <Link href="/" className="inline-flex items-center gap-2 flex-shrink-0">
          <BrandLogo variant="mark" size="sm" priority />
          <span className="font-editorial text-xl font-bold text-text leading-none">strumm~</span>
        </Link>
      </header>

      <aside className="hidden md:flex fixed inset-y-0 left-0 w-64 bg-surface/40 border-r border-border/60 flex-col justify-between z-30 backdrop-blur-md">
        {navContent}
      </aside>

      <AnimatePresence>
        {isOpen && (
          <>
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
              className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm md:hidden"
              aria-label="Close navigation"
            />
            <motion.aside
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 260 }}
              className="fixed inset-y-0 left-0 z-50 w-[82vw] max-w-80 bg-surface border-r border-border/70 flex flex-col justify-between shadow-2xl md:hidden"
            >
              {navContent}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
