"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthStore } from "web/store/useAuthStore";
import { signOut } from "next-auth/react";
import { motion } from "framer-motion";
import {
  Home,
  ListMusic,
  Settings,
  LogOut,
  User as UserIcon,
  Search,
  Radio,
  Download,
  Sparkles,
  Users,
  Tv,
  MessageSquareText,
} from "lucide-react";
import BrandLogo from "web/components/BrandLogo";
import MobileBottomNav from "web/components/MobileBottomNav";
import { useUserAvatar } from "web/lib/useUserAvatar";
import { isNavActive } from "web/lib/routes";

export default function Navigation() {
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const avatarUrl = useUserAvatar(user);

  const navItems = [
    { label: "Home", href: "/", icon: Home },
    { label: "Search", href: "/search", icon: Search },
    { label: "Playlists", href: "/playlists", icon: ListMusic },
    { label: "Podcasts", href: "/podcasts", icon: Radio },
    { label: "Downloads", href: "/downloads", icon: Download },
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
      <div className="p-5 flex-grow overflow-y-auto min-h-0 scrollbar-none">
        <div className="mb-7 flex items-start justify-between gap-3">
          <div>
            <Link
              href="/"
              className="inline-flex items-center gap-3 hover:opacity-95 transition group"
            >
              <div className="p-1.5 rounded-xl border border-primary/30 bg-primary/10 box-glow">
                <BrandLogo variant="mark" size="sm" priority />
              </div>
              <span className="text-3xl font-editorial text-text tracking-tight font-black leading-none group-hover:text-primary transition-colors">
                strumm~
              </span>
            </Link>
            <span className="reform-chip mt-3 ml-1">Where your music lives</span>
          </div>
        </div>

        <nav className="space-y-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = isNavActive(pathname, item.href);
            return (
              <Link key={item.href} href={item.href}>
                <motion.span
                  whileHover={{ scale: 1.02, x: 4 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: "spring", stiffness: 420, damping: 26 }}
                  className={`flex items-center gap-3.5 px-4 py-3 rounded-xl text-[13px] font-extrabold tracking-wide uppercase transition cursor-pointer select-none ${
                    isActive
                      ? "bg-primary text-background border border-primary shadow-[0_8px_24px_-12px_var(--glow)]"
                      : "text-muted hover:text-text hover:bg-surface-elevated/70 border border-transparent hover:border-border/70"
                  }`}
                >
                  <Icon
                    className={`w-4.5 h-4.5 ${isActive ? "text-background" : "text-muted"}`}
                  />
                  {item.label}
                </motion.span>
              </Link>
            );
          })}
        </nav>
      </div>

      {user && (
        <div className="p-4 border-t-2 border-primary/20 bg-gradient-to-r from-primary/10 via-surface/40 to-transparent flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={user.displayName}
                loading="lazy"
                decoding="async"
                className="w-9 h-9 rounded-xl object-cover shadow border-2 border-primary/30"
              />
            ) : (
              <div className="w-9 h-9 rounded-xl bg-surface-elevated border-2 border-border flex items-center justify-center">
                <UserIcon className="w-4 h-4 text-accent" />
              </div>
            )}
            <div className="text-left min-w-0">
              <div className="text-xs font-black text-text truncate leading-tight uppercase tracking-wide">
                {user.displayName}
              </div>
              <div className="text-[10px] text-primary/80 font-semibold truncate">
                @{user.username}
              </div>
            </div>
          </div>

          <motion.button
            onClick={handleLogout}
            whileHover={{ scale: 1.1, rotate: 8 }}
            whileTap={{ scale: 0.92 }}
            transition={{ type: "spring", stiffness: 420, damping: 24 }}
            className="p-2 hover:bg-primary/15 text-primary rounded-xl border border-transparent hover:border-primary/30 cursor-pointer transition"
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
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-64 bg-surface/70 border-r-2 border-border/70 flex-col justify-between z-30 backdrop-blur-xl shadow-[8px_0_40px_-30px_var(--glow)]">
        {sidebarContent}
      </aside>

      {/* Mobile bottom navigation */}
      <MobileBottomNav />
    </>
  );
}
