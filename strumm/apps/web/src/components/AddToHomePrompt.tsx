"use client";

import { useEffect, useState } from "react";
import { Download, X, Smartphone } from "lucide-react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const PROMPT_STORAGE_KEY = "strumm-a2hs-prompt-shown";

function isMobileDevice() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 768px)").matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isStandalone() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
}

export default function AddToHomePrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isMobileDevice() || isStandalone() || localStorage.getItem(PROMPT_STORAGE_KEY) === "true") return;

    setIsIos(/iPhone|iPad|iPod/i.test(navigator.userAgent));

    const fallbackTimer = window.setTimeout(() => {
      setShowPrompt(true);
    }, 1800);

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
      setShowPrompt(true);
      window.clearTimeout(fallbackTimer);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    return () => {
      window.clearTimeout(fallbackTimer);
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, []);

  const dismiss = () => {
    localStorage.setItem(PROMPT_STORAGE_KEY, "true");
    setShowPrompt(false);
  };

  const install = async () => {
    if (!installEvent) {
      dismiss();
      return;
    }

    await installEvent.prompt();
    await installEvent.userChoice.catch(() => null);
    dismiss();
  };

  if (!showPrompt) return null;

  return (
    <div className="fixed left-3 right-3 bottom-40 z-[80] md:hidden">
      <div className="bg-surface-elevated/95 border border-border/80 rounded-xl shadow-2xl p-4 flex items-start gap-3 backdrop-blur-xl">
        <Smartphone className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-editorial font-bold text-text">Add Strumm to Home Screen</h3>
          <p className="text-[11px] text-muted leading-relaxed mt-1">
            {isIos
              ? "Use Share, then Add to Home Screen for the app-style mobile experience."
              : "Install Strumm for faster mobile access and an app-style player."}
          </p>
          <div className="flex items-center gap-2 mt-3">
            {!isIos && installEvent && (
              <button
                type="button"
                onClick={install}
                className="px-3 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-xs font-semibold flex items-center gap-2"
              >
                <Download className="w-3.5 h-3.5" />
                Add
              </button>
            )}
            <button
              type="button"
              onClick={dismiss}
              className="px-3 py-2 rounded-lg border border-border/70 text-muted hover:text-text text-xs font-semibold"
            >
              Not now
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="p-1 rounded-md text-muted hover:text-text hover:bg-white/5"
          title="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
