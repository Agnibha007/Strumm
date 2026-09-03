"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthStore } from "web/store/useAuthStore";
import { signOut } from "next-auth/react";
import { motion } from "framer-motion";
import {
  Home,
  Library,
  ListMusic,
  Settings,
  LogOut,
  User as UserIcon,
  Search,
  Radio,
  Sparkles,
  Users,
  Tv,
  MessageSquareText,
} from "lucide-react";
import BrandLogo from "web/components/BrandLogo";
import MobileBottomNav from "web/components/MobileBottomNav";
import { useUserAvatar } from "web/lib/useUserAvatar";

export default function Navigation() {
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const avatarUrl = useUserAvatar(user);

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
    { label: "Feedback", href: "/feedback", icon: MessageSquareText },
  ];

  const handleLogout = () => {
    logout();
    signOut();
  };

  const sidebarContent = (
    <>
      <div className="p-6 flex-grow overflow-y-auto min-h-0 scrollbar-none">
        <div className="mb-8 flex items-start justify-between gap-3">
          <div>
            <Link
              href="/"
              className="inline-flex items-center gap-3 hover:opacity-90 transition"
            >
              <BrandLogo variant="mark" size="sm" priority />
              <span className="text-2xl font-editorial text-text tracking-tight font-bold leading-none">
                strumm~
              </span>
            </Link>
            <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block mt-2 ml-12">
              Where your music lives.
            </span>
          </div>
        </div>

        <nav className="space-y-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;
            return (
              <Link key={item.href} href={item.href}>
                <motion.span
                  whileHover={{ scale: 1.03, x: 3 }}
                  whileTap={{ scale: 0.97 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25 }}
                  className={`flex items-center gap-3.5 px-4 py-3 rounded-lg text-sm font-semibold transition cursor-pointer select-none ${
                    isActive
                      ? "bg-primary/10 text-primary font-bold border border-primary/20"
                      : "text-muted hover:text-text hover:bg-surface-elevated/40 border border-transparent"
                  }`}
                >
                  <Icon
                    className={`w-4.5 h-4.5 ${isActive ? "text-primary" : "text-muted"}`}
                  />
                  {item.label}
                </motion.span>
              </Link>
            );
          })}
        </nav>
      </div>

      {user && (
        <div className="p-4 border-t border-border/40 bg-surface/30 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={user.displayName}
                loading="lazy"
                decoding="async"
                className="w-8 h-8 rounded-full object-cover shadow border border-border/40"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-surface-elevated border border-border flex items-center justify-center">
                <UserIcon className="w-4 h-4 text-accent" />
              </div>
            )}
            <div className="text-left min-w-0">
              <div className="text-xs font-bold text-text truncate leading-tight">
                {user.displayName}
              </div>
              <div className="text-[9px] text-muted truncate">
                @{user.username}
              </div>
            </div>
          </div>

          <motion.button
            onClick={handleLogout}
            whileHover={{ scale: 1.12, rotate: 10 }}
            whileTap={{ scale: 0.88 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            className="p-1.5 hover:bg-surface-elevated text-primary rounded cursor-pointer transition"
            title="Sign out session"
            aria-label={`Sign out ${user.displayName}`}
          >
            <LogOut className="w-4.5 h-4.5" />
          </motion.button>
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-64 bg-surface/40 border-r border-border/60 flex-col justify-between z-30 backdrop-blur-md">
        {sidebarContent}
      </aside>

      {/* Mobile bottom navigation */}
      <MobileBottomNav />
    </>
  );
}
