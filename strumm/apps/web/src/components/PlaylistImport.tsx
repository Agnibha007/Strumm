"use client";

import { useState } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Check, AlertTriangle, HelpCircle, ArrowRight, Play } from "lucide-react";
import { Song } from "@strumm/types";
import { apiUrl, cleanText } from "web/lib/api";

interface PlaylistImportProps {
  onImported?: () => void;
}

export default function PlaylistImport({ onImported }: PlaylistImportProps) {
  const [activeTab, setActiveTab] = useState<"link" | "csv">("link");
  const [playlistName, setPlaylistName] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [csvContent, setCsvContent] = useState("");
  
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{
    matched: Song[];
    similar_matches: Array<Song & { match_type?: string; confidence?: number }>;
    not_found: Array<{ title: string; artist: string; album?: string; candidates?: any[] }>;
    duplicates: Song[];
    total_matched: number;
    total_similar: number;
    total_failed: number;
  } | null>(null);
  
  const [error, setError] = useState<string | null>(null);
  const { playSong, setQueue } = usePlayerStore();

  const handleImport = async () => {
    if (!playlistName.trim()) {
      setError("Please provide a name for the imported playlist.");
      return;
    }
    
    setLoading(true);
    setError(null);
    setResults(null);
    
    const source = activeTab === "csv" ? "csv" : (inputUrl.includes("spotify") ? "spotify" : "youtube");
    const data = activeTab === "csv" ? csvContent : inputUrl;
    
    try {
      const response = await fetch(apiUrl("/playlists/import"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${localStorage.getItem("strumm-token") || ""}`
        },
        body: JSON.stringify({
          source,
          name: cleanText(playlistName, 120),
          data: activeTab === "csv" ? data.slice(0, 200000) : cleanText(data, 1000)
        })
      });
      
      const json = await response.json();
      if (json.success) {
        setResults(json.data);
        onImported?.();
      } else {
        setError(json.error || "Failed to import. Check format or connection.");
      }
    } catch (e) {
      setError("Failed to connect to API server for import resolution.");
    } finally {
      setLoading(false);
    }
  };

  const allMatchedSongs = results
    ? [...results.matched, ...results.similar_matches]
    : [];

  const playImported = () => {
    if (allMatchedSongs.length > 0) {
      setQueue(allMatchedSongs);
      playSong(allMatchedSongs[0], allMatchedSongs);
    }
  };

  return (
    <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-6">
      <div>
        <h2 className="text-xl font-editorial text-text">Playlist Migrator</h2>
        <p className="text-xs text-muted">Pull music lists from Spotify, YouTube Music, or CSV tables.</p>
      </div>

      <div className="flex gap-2 border-b border-border/20 pb-2">
        <button
          onClick={() => setActiveTab("link")}
          className={`pb-2 px-3 text-xs font-semibold border-b-2 cursor-pointer transition ${
            activeTab === "link" ? "border-primary text-text" : "border-transparent text-muted"
          }`}
        >
          Stream Links
        </button>
        <button
          onClick={() => setActiveTab("csv")}
          className={`pb-2 px-3 text-xs font-semibold border-b-2 cursor-pointer transition ${
            activeTab === "csv" ? "border-primary text-text" : "border-transparent text-muted"
          }`}
        >
          CSV Sheet (Excel)
        </button>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-[11px] uppercase tracking-wider text-muted mb-1.5 font-semibold">
            Import Name
          </label>
          <input
            type="text"
            placeholder="e.g. My Old Favorites"
            value={playlistName}
            onChange={(e) => setPlaylistName(e.target.value)}
            className="w-full bg-background border border-border rounded px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition"
          />
        </div>

        {activeTab === "link" ? (
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-muted mb-1.5 font-semibold">
              Playlist URL
            </label>
            <input
              type="text"
              placeholder="Paste Spotify or YouTube Music link..."
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              className="w-full bg-background border border-border rounded px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition"
            />
          </div>
        ) : (
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-muted mb-1.5 font-semibold">
              CSV Content
            </label>
            <textarea
              rows={4}
              placeholder="title, artist, album&#10;Heer, A.R. Rahman, Jab Tak Hai Jaan&#10;Ghar Kab Aaoge, Sonu Nigam, Border"
              value={csvContent}
              onChange={(e) => setCsvContent(e.target.value)}
              className="w-full bg-background border border-border rounded px-4 py-2.5 text-xs font-mono text-text focus:outline-none focus:border-primary/50 transition resize-none"
            />
            <p className="text-[10px] text-muted mt-1">First row should be headers (title, artist, album).</p>
          </div>
        )}
      </div>

      {error && (
        <div className="text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded">
          {error}
        </div>
      )}

      <button
        onClick={handleImport}
        disabled={loading}
        className="w-full py-2.5 bg-accent hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-background font-editorial text-sm font-semibold rounded cursor-pointer transition flex items-center justify-center gap-2"
      >
        {loading ? "Resolving catalog..." : "Begin Alignment Process"}
        <ArrowRight className="w-4 h-4" />
      </button>

      {results && (
        <div className="border-t border-border/40 pt-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-editorial text-base text-text">Resolution Summary</h3>
            {(results.matched.length > 0 || results.similar_matches.length > 0) && (
              <button
                onClick={playImported}
                className="flex items-center gap-1.5 text-xs text-primary font-semibold hover:underline cursor-pointer"
              >
                <Play className="w-3 h-3 fill-current" />
                Play Matched Songs
              </button>
            )}
          </div>

          <div className="grid grid-cols-4 gap-2">
            <div className="bg-surface-elevated border border-border/40 p-3 rounded text-center">
              <div className="text-lg font-bold text-emerald-500">{results.total_matched}</div>
              <div className="text-[10px] uppercase text-muted">Exact</div>
            </div>
            <div className="bg-surface-elevated border border-border/40 p-3 rounded text-center">
              <div className="text-lg font-bold text-cyan-500">{results.total_similar}</div>
              <div className="text-[10px] uppercase text-muted">Similar</div>
            </div>
            <div className="bg-surface-elevated border border-border/40 p-3 rounded text-center">
              <div className="text-lg font-bold text-amber-500">{results.duplicates.length}</div>
              <div className="text-[10px] uppercase text-muted">Duplicates</div>
            </div>
            <div className="bg-surface-elevated border border-border/40 p-3 rounded text-center">
              <div className="text-lg font-bold text-primary">{results.total_failed}</div>
              <div className="text-[10px] uppercase text-muted">Missing</div>
            </div>
          </div>

          <div className="max-height-[180px] overflow-y-auto space-y-2 border border-border/40 rounded p-3 bg-background/20">
            {results.matched.map((s) => (
              <div key={s.videoId} className="flex items-center justify-between text-xs py-1 border-b border-border/10 last:border-0">
                <span className="text-text font-medium truncate max-w-[70%]">
                  {s.title} <span className="text-muted text-[10px]">by {s.artist}</span>
                </span>
                <span className="flex items-center gap-1 text-[10px] text-emerald-500 font-semibold uppercase">
                  <Check className="w-3 h-3" /> Resolved
                </span>
              </div>
            ))}

            {results.similar_matches.map((s, idx) => (
              <div key={s.videoId + "-sim-" + idx} className="flex items-center justify-between text-xs py-1 border-b border-border/10 last:border-0">
                <span className="text-text font-medium truncate max-w-[60%]">
                  {s.title} <span className="text-muted text-[10px]">by {s.artist}</span>
                </span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {s.confidence != null && (
                    <span className="text-[9px] text-cyan-600 font-mono">
                      {Math.round(s.confidence * 100)}%
                    </span>
                  )}
                  <span className="flex items-center gap-1 text-[10px] text-cyan-500 font-semibold uppercase">
                    <Check className="w-3 h-3" /> Smart Match
                  </span>
                </div>
              </div>
            ))}
            
            {results.duplicates.map((s) => (
              <div key={s.videoId + "-dup"} className="flex items-center justify-between text-xs py-1 border-b border-border/10 last:border-0">
                <span className="text-text font-medium truncate max-w-[70%]">
                  {s.title} <span className="text-muted text-[10px]">by {s.artist}</span>
                </span>
                <span className="flex items-center gap-1 text-[10px] text-amber-500 font-semibold uppercase">
                  <AlertTriangle className="w-3 h-3" /> Duplicate
                </span>
              </div>
            ))}

            {results.not_found.map((s, idx) => (
              <div key={idx} className="flex items-center justify-between text-xs py-1 border-b border-border/10 last:border-0">
                <span className="text-muted truncate max-w-[70%]">
                  {s.title} <span className="text-[10px]">by {s.artist}</span>
                </span>
                <span className="flex items-center gap-1 text-[10px] text-primary font-semibold uppercase">
                  <HelpCircle className="w-3 h-3" /> Missing
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
