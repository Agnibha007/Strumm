"use client";

import { useAuthStore } from "web/store/useAuthStore";

const footerLinks = [
  { href: "/about", label: "About" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/cookies", label: "Cookies" },
  { href: "/dmca", label: "DMCA" },
  { href: "/contact", label: "Contact" },
  { href: "/status", label: "Status" },
  { href: "/changelog", label: "Changelog" },
];

export default function ConditionalFooter() {
  const { token } = useAuthStore();
  const sidebarOffset = token ? "md:ml-64" : "";

  return (
    <footer className={`border-t border-border/40 bg-background/80 backdrop-blur-md ${sidebarOffset}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <div className="flex flex-wrap items-center justify-center sm:justify-between gap-x-6 gap-y-2 text-[11px] text-muted">
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
            <span className="font-semibold text-text whitespace-nowrap">© {new Date().getFullYear()} Strumm</span>
            {footerLinks.slice(0, 6).map((link) => (
              <a key={link.href} href={link.href} className="hover:text-text transition whitespace-nowrap">
                {link.label}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-5">
            {footerLinks.slice(6).map((link) => (
              <a key={link.href} href={link.href} className="hover:text-text transition whitespace-nowrap">
                {link.label}
              </a>
            ))}
            <a href="https://github.com/strumm/strumm" target="_blank" rel="noopener noreferrer" className="hover:text-text transition whitespace-nowrap">
              GitHub
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
