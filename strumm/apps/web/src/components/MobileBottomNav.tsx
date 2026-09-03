"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthStore } from "web/store/useAuthStore";
import { motion, AnimatePresence } from "framer-motion";
import {
  Home,
  Search,
  Library,
  Radio,
  User,
  Settings,
  MessageSquareText,
  ListMusic,
  Sparkles,
  Users,
  Tv,
  LogOut,
  X,
  ChevronRight,
} from "lucide-react";
import BrandLogo from "web/components/BrandLogo";
import { signOut } from "next-auth/react";
import { useUserAvatar } from "web/lib/useUserAvatar";

const bottomNavItems = [
  { label: "Home", href: "/", icon: Home },
  { label: "Search", href: "/search", icon: Search },
  { label: "Library", href: "/library", icon: Library },
  { label: "Podcasts", href: "/podcasts", icon: Radio },
  { label: "More", href: "#more", icon: User },
];

const moreItems = [
  { label: "Profile", href: "/profile", icon: User },
  { label: "Settings", href: "/settings", icon: Settings },
  { label: "Feedback", href: "/feedback", icon: MessageSquareText },
  { label: "Playlists", href: "/playlists", icon: ListMusic },
  { label: "Strumm Flow", href: "/flow", icon: Sparkles },
  { label: "Circle", href: "/circle", icon: Users },
  { label: "Rooms", href: "/rooms", icon: Tv },
  { label: "Replay", href: "/replay", icon: Sparkles },
];

export default function MobileBottomNav() {
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const avatarUrl = useUserAvatar(user);
  const [showMore, setShowMore] = useState(false);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  const handleLogout = () => {
    logout();
    signOut();
    setShowMore(false);
  };

  return (
    <>
      {/* Bottom navigation bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-surface/95 backdrop-blur-xl border-t border-border/60 safe-area-bottom">
        <div className="flex items-center justify-around px-2 py-1.5">
          {bottomNavItems.map((item) => {
            const Icon = item.icon;
            const active = item.href !== "#more" ? isActive(item.href) : false;
            const isMoreActive = showMore;

            return item.href === "#more" ? (
              <motion.button
                key={item.label}
                onClick={() => setShowMore(true)}
                whileTap={{ scale: 0.92 }}
                transition={{ type: "spring", stiffness: 500, damping: 20 }}
                className={`flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-xl transition cursor-pointer select-none min-w-0 ${
                  isMoreActive
                    ? "text-primary"
                    : "text-muted hover:text-text"
                }`}
                aria-label="More options"
              >
                <Icon className="w-5 h-5" />
                <span className="text-[9px] font-semibold tracking-wide uppercase">
                  {item.label}
                </span>
              </motion.button>
            ) : (
              <Link
                key={item.label}
                href={item.href}
                className={`flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-xl transition min-w-0 ${
                  active
                    ? "text-primary"
                    : "text-muted hover:text-text"
                }`}
              >
                <motion.div
                  whileTap={{ scale: 0.92 }}
                  transition={{ type: "spring", stiffness: 500, damping: 20 }}
                  className="flex flex-col items-center justify-center gap-0.5"
                >
                  <Icon className="w-5 h-5" />
                  <span className="text-[9px] font-semibold tracking-wide uppercase">
                    {item.label}
                  </span>
                </motion.div>
                {active && (
                  <motion.div
                    layoutId="bottom-nav-indicator"
                    className="w-1 h-1 rounded-full bg-primary mt-0.5"
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  />
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* More Bottom Sheet */}
      <AnimatePresence>
        {showMore && (
          <div className="fixed inset-0 z-[60] md:hidden">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setShowMore(false)}
              className="absolute inset-0 bg-background/70 backdrop-blur-sm"
            />

            {/* Sheet */}
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 260 }}
              className="absolute bottom-0 left-0 right-0 bg-surface border-t border-border/70 rounded-t-2xl shadow-2xl max-h-[85vh] overflow-y-auto"
            >
              {/* Sheet handle */}
              <div className="flex items-center justify-between px-5 pt-4 pb-2 border-b border-border/20 sticky top-0 bg-surface z-10">
                <div className="flex items-center gap-3">
                  <BrandLogo variant="mark" size="sm" priority />
                  <span className="font-editorial text-lg text-text font-bold">
                    More
                  </span>
                </div>
                <motion.button
                  onClick={() => setShowMore(false)}
                  whileHover={{ scale: 1.1, rotate: 90 }}
                  whileTap={{ scale: 0.9 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25 }}
                  className="p-2 text-muted hover:text-text hover:bg-surface-elevated rounded-lg transition"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </motion.button>
              </div>

              {/* User section */}
              {user && (
                <div className="px-5 py-4 border-b border-border/20 bg-surface/30">
                  <div className="flex items-center gap-3">
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt={user.displayName}
                        loading="lazy"
                        decoding="async"
                        className="w-10 h-10 rounded-full object-cover shadow border border-border/40"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-surface-elevated border border-border flex items-center justify-center">
                        <User className="w-5 h-5 text-accent" />
                      </div>
                    )}
                    <div className="text-left min-w-0 flex-1">
                      <div className="text-sm font-bold text-text truncate leading-tight">
                        {user.displayName}
                      </div>
                      <div className="text-[10px] text-muted truncate">
                        @{user.username}
                      </div>
                    </div>
                    <button
                      onClick={handleLogout}
                      className="p-2 hover:bg-surface-elevated text-primary hover:text-primary/80 rounded-lg transition cursor-pointer"
                      title="Sign out"
                      aria-label="Sign out"
                    >
                      <LogOut className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Navigation items */}
              <div className="px-3 py-3 space-y-1">
                {moreItems.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  return (
                    <Link key={item.href} href={item.href} onClick={() => setShowMore(false)}>
                      <motion.div
                        whileHover={{ x: 4 }}
                        whileTap={{ scale: 0.95 }}
                        transition={{ type: "spring", stiffness: 500, damping: 20 }}
                        className={`flex items-center gap-3.5 px-4 py-3 rounded-xl text-sm font-semibold transition cursor-pointer select-none ${
                          active
                            ? "bg-primary/10 text-primary border border-primary/20"
                            : "text-muted hover:text-text hover:bg-surface-elevated/40 border border-transparent"
                        }`}
                      >
                        <Icon className={`w-4.5 h-4.5 ${active ? "text-primary" : "text-muted"}`} />
                        <span className="flex-1">{item.label}</span>
                        <ChevronRight className="w-3.5 h-3.5 text-muted/40" />
                      </motion.div>
                    </Link>
                  );
                })}
              </div>

              {/* Footer info */}
              <div className="px-5 py-4 border-t border-border/20 text-center">
                <span className="text-[9px] text-muted/50">
                  Strumm &copy; {new Date().getFullYear()}
                </span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
