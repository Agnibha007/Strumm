"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { Radio, Plus, Rss, ArrowRight, Library, User, Loader2, Info, Search } from "lucide-react";
import { PodcastShow } from "@strumm/types";
import { useRouter } from "next/navigation";
import { apiUrl, cleanText } from "web/lib/api";
import SafePodcastImage from "web/components/SafePodcastImage";

export default function PodcastHomePage() {
  const { token } = useAuthStore();
  const router = useRouter();

  const [shows, setShows] = useState<PodcastShow[]>([]);
  const [followedShows, setFollowedShows] = useState<PodcastShow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [podcastQuery, setPodcastQuery] = useState("");
  
  // RSS Import states
  const [rssUrl, setRssUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const loadPodcasts = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 1. Fetch available shows
      const cleanedQuery = cleanText(podcastQuery, 120);
      const showsPath = cleanedQuery
        ? `/podcasts/shows?query=${encodeURIComponent(cleanedQuery)}`
        : "/podcasts/shows";
      const showsResp = await fetch(apiUrl(showsPath));
      if (!showsResp.ok) {
        throw new Error("Podcast catalog request failed.");
      }
      const showsJson = await showsResp.json();
      if (showsJson.success && showsJson.data) {
        setShows(showsJson.data);
      } else {
        setShows([]);
      }

      // 2. Fetch followed shows
      if (token) {
        const libraryResp = await fetch(apiUrl("/library"), {
          headers: { "Authorization": `Bearer ${token}` }
        });
        const libJson = await libraryResp.json().catch(() => null);
        if (libraryResp.ok && libJson?.success && showsJson.data) {
          // Backend does not expose followed podcast IDs yet; keep this empty instead of showing fake follows.
          setFollowedShows([]);
        }
      } else {
        setFollowedShows([]);
      }
    } catch (e: any) {
      setShows([]);
      setFollowedShows([]);
      setLoadError(e?.message || "Unable to fetch podcasts list.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadPodcasts();
    }, podcastQuery.trim() ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [token, podcastQuery]);

  const handleImportRss = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rssUrl.trim()) return;

    setImporting(true);
    setImportError(null);
    setImportSuccess(null);

    try {
      const response = await fetch(apiUrl("/podcasts/import-rss"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ rss_url: cleanText(rssUrl, 1000) })
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(json?.error || "RSS import request failed.");
      }
      if (json.success && json.data) {
        setImportSuccess(json.message || "Podcast RSS imported successfully.");
        setRssUrl("");
        loadPodcasts(); // reload directory
      } else {
        setImportError(json?.error || "Failed to parse RSS feed.");
      }
    } catch (err: any) {
      setImportError(err?.message || "Unable to connect to backend server.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-10 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
            Audio Chronicles
          </span>
          <h2 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1">
            Podcast Portal
          </h2>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Import module and Followed Shows */}
        <div className="lg:col-span-8 space-y-8">
          {/* Followed Podcasts */}
          <div className="space-y-4">
            <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
              Followed Chronicles
            </h3>
            {loading ? (
              <p className="text-xs text-muted">Syncing followed feeds...</p>
            ) : followedShows.length === 0 ? (
              <p className="text-xs text-muted italic">No followed podcast feeds. Import or explore the catalog below.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {followedShows.map((show) => (
                  <a
                    key={show.id}
                    href={`/podcasts/show/${show.id}`}
                    className="p-4 bg-surface/40 hover:bg-surface border border-border/40 hover:border-border/85 rounded-xl flex items-center gap-4 transition group cursor-pointer"
                  >
                    <SafePodcastImage
                      src={show.image}
                      alt={show.title}
                      loading="lazy"
                      decoding="async"
                      className="w-16 h-16 rounded-lg object-cover shadow border border-border/40 flex-shrink-0"
                    />
                    <div className="min-w-0 flex-1 text-left overflow-hidden">
                      <div className="font-editorial text-base text-text font-bold leading-tight group-hover:text-primary transition truncate break-words">
                        {show.title}
                      </div>
                      <div className="text-[10px] text-muted truncate mt-1 break-words">
                        By {show.author}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Directory Catalog */}
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/20 pb-2">
              <h3 className="font-editorial text-xl text-text">
                Ecosystem Catalog
              </h3>
              <div className="relative w-full sm:w-72">
                <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted" />
                <input
                  type="search"
                  value={podcastQuery}
                  onChange={(e) => setPodcastQuery(e.target.value)}
                  placeholder="Search podcasts"
                  className="w-full bg-background border border-border rounded-lg pl-9 pr-3 py-2 text-xs text-text focus:outline-none focus:border-primary/50 transition"
                />
              </div>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-muted py-6">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span>{podcastQuery.trim() ? "Searching podcast catalog..." : "Reading podcast catalog..."}</span>
              </div>
            ) : loadError ? (
              <p className="text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded-lg leading-relaxed">
                {loadError}
              </p>
            ) : shows.length === 0 ? (
              <p className="text-xs text-muted italic py-6">
                {podcastQuery.trim() ? "No podcasts matched that search." : "Ecosystem catalog is empty. Paste an RSS feed to start streaming."}
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {shows.map((show) => (
                  <a
                    key={show.id}
                    href={`/podcasts/show/${show.id}`}
                    className="p-3 bg-surface/30 border border-border/40 hover:bg-surface hover:border-border/80 rounded-xl transition text-left block cursor-pointer"
                  >
                    <div className="w-full aspect-square rounded-lg bg-surface-elevated overflow-hidden border border-border/40 shadow relative">
                      <SafePodcastImage
                        src={show.image}
                        alt={show.title}
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute right-2.5 bottom-2.5 p-1.5 bg-black/60 rounded-full">
                        <Radio className="w-4 h-4 text-primary" />
                      </div>
                    </div>
                    <div className="min-w-0 w-full overflow-hidden">
                      <div className="font-editorial text-sm text-text font-bold mt-3.5 truncate break-words w-full">
                        {show.title}
                      </div>
                      <div className="text-[10px] text-muted truncate mt-1 break-words w-full">
                        By {show.author}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: Premium RSS Feed Importer */}
        <div className="lg:col-span-4 bg-surface border border-border/60 rounded-xl p-6 space-y-6">
          <div>
            <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
              RSS Feed Integrator
            </h3>
            <p className="text-[11px] text-muted mt-1.5 leading-relaxed">
              Synthesize standard podcast archives directly using a public RSS feed link.
            </p>
          </div>

          <form onSubmit={handleImportRss} className="space-y-4">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">
                RSS Feed URL
              </label>
              <div className="relative">
                <Rss className="absolute left-3.5 top-3.5 w-4 h-4 text-muted" />
                <input
                  type="url"
                  placeholder="https://example.com/feed.xml"
                  value={rssUrl}
                  onChange={(e) => setRssUrl(e.target.value)}
                  className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2.5 text-xs text-text focus:outline-none focus:border-primary/50 transition font-mono"
                  required
                />
              </div>
            </div>

            {importError && (
              <div className="text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded-lg leading-relaxed">
                {importError}
              </div>
            )}

            {importSuccess && (
              <div className="text-xs text-emerald-500 bg-emerald-500/5 border border-emerald-500/20 p-3 rounded-lg leading-relaxed">
                {importSuccess}
              </div>
            )}

            <button
              type="submit"
              disabled={importing}
              className="w-full py-2.5 bg-text hover:bg-white text-background font-editorial text-xs font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50"
            >
              {importing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-background" />
                  Parsing Feed...
                </>
              ) : (
                <>
                  Import RSS Archive
                  <ArrowRight className="w-3.5 h-3.5 text-background" />
                </>
              )}
            </button>
          </form>

          {/* Quick instructions / examples */}
          <div className="border-t border-border/20 pt-4 space-y-2 text-[10px] text-muted">
            <span className="font-semibold uppercase tracking-wider block text-text flex items-center gap-1">
              <Info className="w-3 h-3 text-primary" /> Supported Formats
            </span>
            <p className="leading-relaxed">
              Standard XML/RSS audio enclosures (e.g. Apple Podcasts, Spotify, RSS-native audio hosting feeds).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
