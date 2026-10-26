"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

type CheckState = "operational" | "degraded" | "unknown" | "checking";

interface ProbeResult {
  ok: boolean;
  status: number;
  json: any;
}

interface ServiceCheck {
  id: string;
  name: string;
  description: string;
  state: CheckState;
  detail: string;
}

const HEALTH_TIMEOUT_MS = 8000;
const REFRESH_INTERVAL_MS = 60_000;

async function probe(url: string): Promise<ProbeResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const json = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, json };
  } catch {
    // Network error, timeout, or the request was aborted.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const UNMONITORED_SERVICES: Omit<ServiceCheck, "state" | "detail">[] = [
  {
    id: "youtube",
    name: "YouTube Streaming",
    description: "Track and video delivery via YouTube / Invidious",
  },
  {
    id: "ai",
    name: "AI Recommendations (Groq)",
    description: "Discovery mixes and written recommendations",
  },
  {
    id: "email",
    name: "Email Delivery (Resend)",
    description: "Verification and password-reset mail",
  },
  {
    id: "realtime",
    name: "WebSocket Realtime",
    description: "Rooms, live sync, and cross-device player state",
  },
];

/**
 * Truthful status page.
 *
 * This page used to render a hardcoded "All systems operational" banner for every
 * service and claim it was refreshed every 60 seconds — it never made a single
 * request. A status page that cannot be wrong is worse than no status page: it
 * actively misleads people during an outage.
 *
 * Only the two checks the API actually exposes are probed (liveness + database).
 * Everything else is labelled honestly as not independently monitored instead of
 * being asserted healthy.
 */
export default function StatusClient() {
  const [apiCheck, setApiCheck] = useState<ServiceCheck>({
    id: "api",
    name: "API Server",
    description: "Strumm backend (FastAPI)",
    state: "checking",
    detail: "Checking…",
  });
  const [dbCheck, setDbCheck] = useState<ServiceCheck>({
    id: "db",
    name: "Database (MongoDB)",
    description: "Persistent storage for profiles, playlists, and history",
    state: "checking",
    detail: "Checking…",
  });
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const inFlightRef = useRef(false);

  const runChecks = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);

    const [api, db] = await Promise.all([
      probe("/proxy/health"),
      probe("/proxy/health/db"),
    ]);

    if (!api) {
      setApiCheck({
        id: "api",
        name: "API Server",
        description: "Strumm backend (FastAPI)",
        state: "unknown",
        detail: "No response — the health endpoint could not be reached.",
      });
    } else if (api.ok) {
      setApiCheck({
        id: "api",
        name: "API Server",
        description: "Strumm backend (FastAPI)",
        state: "operational",
        detail: `Responded in a healthy state (HTTP ${api.status}).`,
      });
    } else {
      setApiCheck({
        id: "api",
        name: "API Server",
        description: "Strumm backend (FastAPI)",
        state: "degraded",
        detail: `Health endpoint returned HTTP ${api.status}.`,
      });
    }

    if (!db) {
      setDbCheck({
        id: "db",
        name: "Database (MongoDB)",
        description: "Persistent storage for profiles, playlists, and history",
        state: "unknown",
        detail: "Could not determine database health — the API did not answer.",
      });
    } else if (db.ok && db.json?.data?.status === "healthy") {
      setDbCheck({
        id: "db",
        name: "Database (MongoDB)",
        description: "Persistent storage for profiles, playlists, and history",
        state: "operational",
        detail: "Connection verified by the API.",
      });
    } else {
      setDbCheck({
        id: "db",
        name: "Database (MongoDB)",
        description: "Persistent storage for profiles, playlists, and history",
        state: "degraded",
        detail:
          db.json?.error ||
          `Database probe returned HTTP ${db.status}.`,
      });
    }

    setCheckedAt(new Date());
    setRefreshing(false);
    inFlightRef.current = false;
  }, []);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  // Refresh while the page is visible. A hidden tab does not poll.
  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void runChecks();
    };
    const interval = setInterval(tick, REFRESH_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) void runChecks();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [runChecks]);

  const checks: ServiceCheck[] = [apiCheck, dbCheck];
  const unmonitored: ServiceCheck[] = UNMONITORED_SERVICES.map((service) => ({
    ...service,
    state: "unknown" as const,
    detail: "Not independently monitored — no public health probe is exposed.",
  }));

  const coreDown = apiCheck.state === "degraded" || dbCheck.state === "degraded";
  const coreUnknown = apiCheck.state === "unknown" || dbCheck.state === "unknown";
  const stillChecking = apiCheck.state === "checking" || dbCheck.state === "checking";

  const banner = stillChecking
    ? {
        tone: "border-border/60 bg-surface/40",
        dot: "bg-muted",
        text: "Checking service health…",
        textTone: "text-muted",
      }
    : coreDown
      ? {
          tone: "border-red-500/30 bg-red-500/10",
          dot: "bg-red-500",
          text: "Partial outage — a core service is degraded",
          textTone: "text-red-400",
        }
      : coreUnknown
        ? {
            tone: "border-amber-500/30 bg-amber-500/10",
            dot: "bg-amber-500",
            text: "Status unknown — health checks could not complete",
            textTone: "text-amber-400",
          }
        : {
            tone: "border-emerald-500/20 bg-emerald-500/10",
            dot: "bg-emerald-500",
            text: "Core platform operational",
            textTone: "text-emerald-400",
          };

  const stateLabel = (state: CheckState) => {
    switch (state) {
      case "operational":
        return "Operational";
      case "degraded":
        return "Degraded";
      case "unknown":
        return "Unknown";
      default:
        return "Checking";
    }
  };

  const stateTone = (state: CheckState) => {
    switch (state) {
      case "operational":
        return { text: "text-emerald-400", dot: "bg-emerald-500" };
      case "degraded":
        return { text: "text-red-400", dot: "bg-red-500" };
      case "unknown":
        return { text: "text-amber-400", dot: "bg-amber-500" };
      default:
        return { text: "text-muted", dot: "bg-muted" };
    }
  };

  return (
    <div className="max-w-3xl py-12 px-4 md:px-0 soft-enter">
      <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">
        System
      </span>
      <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-2">
        Service Status
      </h1>
      <p className="text-sm text-muted mb-8">
        Live health checks for the services that expose a public probe. Everything
        else is labelled for what it is.
      </p>

      <div
        role="status"
        aria-live="polite"
        className={`${banner.tone} border rounded-xl p-4 mb-6 flex items-center gap-3`}
      >
        <div className={`w-2.5 h-2.5 rounded-full ${banner.dot} flex-shrink-0`} />
        <span className={`text-xs font-semibold ${banner.textTone}`}>{banner.text}</span>
      </div>

      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="text-xs uppercase tracking-widest font-semibold text-muted">
          Monitored
        </h2>
        <button
          onClick={() => void runChecks()}
          disabled={refreshing}
          className="text-[11px] font-semibold text-muted hover:text-text transition flex items-center gap-1.5 disabled:opacity-50 cursor-pointer disabled:cursor-default"
        >
          {refreshing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Refresh
        </button>
      </div>

      <div className="space-y-2">
        {checks.map((check) => {
          const tone = stateTone(check.state);
          return (
            <div
              key={check.id}
              className="bg-surface/40 border border-border/60 rounded-xl px-5 py-4"
            >
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-semibold text-text">{check.name}</span>
                <span className={`text-xs font-semibold flex items-center gap-2 ${tone.text}`}>
                  <span className={`w-2 h-2 rounded-full ${tone.dot}`} />
                  {stateLabel(check.state)}
                </span>
              </div>
              <p className="text-[11px] text-muted mt-1">{check.description}</p>
              <p className="text-[11px] text-muted/80 mt-1">{check.detail}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-8">
        <h2 className="text-xs uppercase tracking-widest font-semibold text-muted mb-4">
          Not independently monitored
        </h2>
        <div className="space-y-2">
          {unmonitored.map((check) => (
            <div
              key={check.id}
              className="bg-surface/20 border border-border/40 rounded-xl px-5 py-4"
            >
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-semibold text-text/80">{check.name}</span>
                <span className="text-xs font-semibold flex items-center gap-2 text-amber-400/80">
                  <span className="w-2 h-2 rounded-full bg-amber-500/70" />
                  {stateLabel(check.state)}
                </span>
              </div>
              <p className="text-[11px] text-muted mt-1">{check.description}</p>
              <p className="text-[11px] text-muted/70 mt-1">{check.detail}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10 text-center space-y-1">
        {checkedAt ? (
          <p className="text-xs text-muted">
            Last checked {checkedAt.toLocaleTimeString()} · refreshes every 60 seconds while
            this page is visible.
          </p>
        ) : (
          <p className="text-xs text-muted">Waiting for the first health check…</p>
        )}
        <p className="text-xs text-muted">
          Seeing a problem that is not shown here? Contact{" "}
          <a href="mailto:support@strumm.me" className="text-primary hover:underline">
            support@strumm.me
          </a>
        </p>
      </div>
    </div>
  );
}
