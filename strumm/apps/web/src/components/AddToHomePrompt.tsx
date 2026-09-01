"use client";

import { useEffect, useState } from "react";
import { Download, X, Smartphone } from "lucide-react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const PROMPT_STORAGE_KEY = "strumm-a2hs-prompt-shown";

// The browser fires `beforeinstallprompt` once, early (before this component
// usually mounts — it only renders when logged in). Hold the latest event at
// module scope so the popup's Add button still has the install prompt whenever
// it appears, instead of relying on a mount-time listener that can miss it.
let savedInstallEvent: BeforeInstallPromptEvent | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    savedInstallEvent = e as BeforeInstallPromptEvent;
  });
}

function isMobileDevice() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 768px)").matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isStandalone() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
}

export default function AddToHomePrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(savedInstallEvent);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showManual, setShowManual] = useState(false);
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
      savedInstallEvent = event as BeforeInstallPromptEvent;
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
    const evt = installEvent || savedInstallEvent;
    if (!evt) {
      // Chrome never surfaced a `beforeinstallprompt` (e.g. it already fired
      // before we logged in, or the launch flow wasn't installable yet).
      // Fall back to guided manual steps instead of silently doing nothing.
      setShowManual(true);
      return;
    }

    try {
      await evt.prompt();
      await evt.userChoice.catch(() => null);
    } catch (e) {
      // prompt() can throw if the event is stale (previously used or expired).
      setShowManual(true);
      return;
    }
    dismiss();
  };

  if (!showPrompt) return null;

  return (
    <div className="fixed left-3 right-3 bottom-40 z-[80] md:hidden">
      {showManual ? (
        <div className="bg-surface-elevated/95 border border-border/80 rounded-xl shadow-2xl p-4 space-y-3 backdrop-blur-xl">
          <div className="flex items-start gap-3">
            <Smartphone className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-editorial font-bold text-text">Install Strumm Manually</h3>
              <p className="text-[11px] text-muted leading-relaxed mt-1">
                {isIos
                  ? "Open the Share button (the square with an up arrow) in your browser, then tap “Add to Home Screen”."
                  : "Open the browser’s three-dot menu, then tap “Add to Home screen” (or “Install app”)."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowPrompt(false)}
              className="p-1 rounded-md text-muted hover:text-text hover:bg-white/5"
              title="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="w-full py-2 rounded-lg border border-border/70 text-muted hover:text-text text-xs font-semibold"
          >
            Got it
          </button>
        </div>
      ) : (
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
            <button
              type="button"
              onClick={install}
              className="px-3 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-xs font-semibold flex items-center gap-2"
            >
              <Download className="w-3.5 h-3.5" />
              Add to Home Screen
            </button>
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
      )}
    </div>
  );
}
