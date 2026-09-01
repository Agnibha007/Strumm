"use client";

import { useState } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useAuthStore } from "web/store/useAuthStore";
import { Check, AlertTriangle, HelpCircle, ArrowRight, Play, Plus } from "lucide-react";
import { Song } from "@strumm/types";
import { apiUrl, cleanText } from "web/lib/api";
import SongArtwork from "web/components/SongArtwork";
import { resolveTracksOnBrowser, BrowserMusicCandidate } from "web/services/search/BrowserYouTubeMusicResolver";

interface PlaylistImportProps {
  onImported?: () => void;
}

export default function PlaylistImport({ onImported }: PlaylistImportProps) {
  const [activeTab, setActiveTab] = useState<"link" | "csv">("link");
  const [playlistName, setPlaylistName] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [csvContent, setCsvContent] = useState("");
  
  const [loading, setLoading] = useState(false);
  type ImportFailure = {
    title: string;
    artist: string;
    album?: string;
    status?: string;
    reason?: string;
    confidence?: number;
    candidates?: ImportCandidate[];
  };

  type ImportCandidate = {
    videoId?: string;
    title?: string;
    artist?: string;
    thumbnail?: string;
    duration?: number;
  };

  const [results, setResults] = useState<{
    matched: Song[];
    similar_matches: Array<Song & { match_type?: string; confidence?: number }>;
    not_found: ImportFailure[];
    duplicates: Song[];
    failed: ImportFailure[];
    ambiguous: ImportFailure[];
    skipped: ImportFailure[];
    total_matched: number;
    total_similar: number;
    total_not_found: number;
    total_failed: number;
    total_ambiguous: number;
    total_skipped: number;
    total_tracks: number;
    playlistId?: string | null;
  } | null>(null);
  
  const [error, setError] = useState<string | null>(null);
  const { playSong, setQueue } = usePlayerStore();
  const token = useAuthStore((s) => s.token);

  const [playlistId, setPlaylistId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [chooserBusy, setChooserBusy] = useState<Record<string, boolean>>({});
  const [chooserError, setChooserError] = useState<string | null>(null);

  const ensurePlaylist = async (): Promise<string> => {
    if (playlistId) return playlistId;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": token ? `Bearer ${token}` : "",
    };
    const res = await fetch(apiUrl("/playlists"), {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({
        name: `Imported: ${cleanText(playlistName, 120) || "Playlist"}`,
        visibility: "private",
      }),
    });
    const json = await res.json();
    if (!json.success || !json.data?.id) {
      throw new Error(json.error || "Could not create the imported playlist.");
    }
    setPlaylistId(json.data.id as string);
    return json.data.id as string;
  };

  const chooseCandidate = async (candidate: ImportCandidate) => {
    const cid = candidate.videoId;
    if (!cid || addedIds.has(cid) || chooserBusy[cid]) return;
    setChooserBusy((b) => ({ ...b, [cid]: true }));
    setChooserError(null);
    const headers = {
      "Content-Type": "application/json",
      "Authorization": token ? `Bearer ${token}` : "",
    };
    try {
      const id = await ensurePlaylist();
      const res = await fetch(apiUrl(`/playlists/${id}/songs`), {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({
          song: {
            videoId: cid,
            title: candidate.title || "Untitled",
            artist: candidate.artist || "Unknown Artist",
            thumbnail: candidate.thumbnail || "",
            duration: candidate.duration || 0,
          },
        }),
      });
      const json = await res.json();
      if (!json.success) {
        if (String(json.error || "").toLowerCase().includes("already")) {
          setAddedIds((prev) => new Set(prev).add(cid));
        } else {
          setChooserError(json.error || "Could not add the chosen track.");
        }
        return;
      }
      setAddedIds((prev) => new Set(prev).add(cid));
    } catch {
      setChooserError("Couldn't reach the server to add the chosen track.");
    } finally {
      setChooserBusy((b) => {
        const next = { ...b };
        delete next[cid];
        return next;
      });
    }
  };

  const renderChooser = (item: ImportFailure) => {
    const cands: ImportCandidate[] = (item.candidates || []).filter((c) => c && c.videoId);
    if (cands.length === 0) return null;
    return (
      <div className="mt-2 pl-3 border-l-2 border-border/40 space-y-1.5">
        <p className="text-[10px] uppercase tracking-wider text-muted">Choose a match to add</p>
        {cands.map((c) => {
          const cid = c.videoId as string;
          const added = addedIds.has(cid);
          const busy = !!chooserBusy[cid];
          return (
            <div key={cid} className="flex items-center gap-2 py-0.5">
              <SongArtwork
                song={{ videoId: cid, thumbnail: c.thumbnail || "", title: c.title || "" }}
                className="w-8 h-8 rounded flex-shrink-0"
                iconClassName="w-3 h-3"
              />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-text truncate">{c.title}</p>
                <p className="text-[10px] text-muted truncate">{c.artist}</p>
              </div>
              <button
                onClick={() => chooseCandidate(c)}
                disabled={added || busy}
                className={`flex items-center gap-1 text-[10px] font-semibold uppercase px-2 py-1 rounded cursor-pointer transition ${
                  added ? "text-emerald-500" : "text-accent hover:bg-accent/10"
                }`}
              >
                {added ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                {added ? "Added" : busy ? "Adding…" : "Add"}
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  const handleImport = async () => {
    if (!playlistName.trim()) {
      setError("Please provide a name for the imported playlist.");
      return;
    }
    
    setLoading(true);
    setError(null);
    setResults(null);
    setPlaylistId(null);
    setAddedIds(new Set());
    setChooserError(null);
    
    const source = activeTab === "csv" ? "csv" : (inputUrl.includes("spotify") ? "spotify" : "youtube");
    const data = activeTab === "csv" ? csvContent : inputUrl;
    const payload = {
      source,
      name: cleanText(playlistName, 120),
      data: activeTab === "csv" ? data.slice(0, 200000) : cleanText(data, 1000)
    };
    const headers = {
      "Content-Type": "application/json",
      "Authorization": token ? `Bearer ${token}` : "",
    };
    
    try {
      // Step 1: parse (without resolving) so the browser knows the exact
      // track list to look up with YouTube Music.
      const parseResponse = await fetch(apiUrl("/playlists/import/parse"), {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify(payload)
      });
      const parseJson = await parseResponse.json();
      if (!parseJson.success || !Array.isArray(parseJson.tracks) || parseJson.tracks.length === 0) {
        setError(parseJson.error || "Failed to parse the playlist. Check format or connection.");
        return;
      }
      const tracks: Array<{ title: string; artist: string; album?: string }> = parseJson.tracks;

      // Step 2: resolve each unique track query in the browser with the
      // keyless Piped instances (no API key/quota, works from any origin).
      // Degrades to an empty map when unavailable; the API then falls back to
      // its server-side provider chain per track.
      const indexedQueries = tracks.map((t, i) => ({
        index: i,
        query: [t.title, t.artist].filter((s) => s && s.trim()).join(" ").trim() || t.title,
      }));
      const unique = Array.from(new Set(indexedQueries.map((q) => q.query)));
      const resolved = await resolveTracksOnBrowser(unique, { limit: 8, concurrency: 3 });

      const candidates: Record<number, BrowserMusicCandidate[]> = {};
      for (const { index, query } of indexedQueries) {
        const found = resolved[query];
        if (found && found.length > 0) candidates[index] = found;
      }

      // Step 3: hand browser candidates (keyed by track index) to the API,
      // which ranks them with its normal matcher and persists the playlist.
      const resolveResponse = await fetch(apiUrl("/playlists/import/resolve"), {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ ...payload, candidates })
      });

      const json = await resolveResponse.json();
      if (json.success) {
        setResults(json.data);
        setPlaylistId(json.data.playlistId ?? null);
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
              <div className="text-lg font-bold text-primary">{results.not_found.length}</div>
              <div className="text-[10px] uppercase text-muted">Missing</div>
            </div>
          </div>

          {(results.failed?.length > 0 || results.ambiguous?.length > 0 || results.skipped?.length > 0) && (
            <div className="text-[11px] text-muted flex flex-wrap gap-x-4 gap-y-1 border-t border-border/40 pt-3">
              {results.failed?.length > 0 && (
                <span>
                  <span className="text-primary font-semibold">{results.failed.length} failed to resolve</span> (search/network)
                </span>
              )}
              {results.ambiguous?.length > 0 && (
                <span>
                  <span className="text-amber-500 font-semibold">{results.ambiguous.length} ambiguous</span> (multiple candidates)
                </span>
              )}
              {results.skipped?.length > 0 && (
                <span>
                  <span className="text-muted font-semibold">{results.skipped.length} skipped</span> (missing metadata)
                </span>
              )}
            </div>
          )}

          {chooserError && (
            <div className="text-[11px] text-primary bg-primary/5 border border-primary/20 p-2 rounded">
              {chooserError}
            </div>
          )}

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
              <div key={idx} className="border-b border-border/10 last:border-0 py-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted truncate max-w-[70%]">
                    {s.title} <span className="text-[10px]">by {s.artist}</span>
                  </span>
                  <span title={s.reason} className="flex items-center gap-1 text-[10px] text-primary font-semibold uppercase">
                    <HelpCircle className="w-3 h-3" /> Missing
                  </span>
                </div>
                {renderChooser(s)}
              </div>
            ))}

            {results.failed?.map((s, idx) => (
              <div key={"fail-" + idx} className="border-b border-border/10 last:border-0 py-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted truncate max-w-[70%]">
                    {s.title} <span className="text-[10px]">by {s.artist}</span>
                  </span>
                  <span title={s.reason} className="flex items-center gap-1 text-[10px] text-primary font-semibold uppercase">
                    <AlertTriangle className="w-3 h-3" /> Couldn&apos;t Resolve
                  </span>
                </div>
                {renderChooser(s)}
              </div>
            ))}

            {results.ambiguous?.map((s, idx) => (
              <div key={"amb-" + idx} className="border-b border-border/10 last:border-0 py-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted truncate max-w-[70%]">
                    {s.title} <span className="text-[10px]">by {s.artist}</span>
                  </span>
                  <span title={s.reason} className="flex items-center gap-1 text-[10px] text-amber-500 font-semibold uppercase">
                    <HelpCircle className="w-3 h-3" /> Ambiguous
                  </span>
                </div>
                {renderChooser(s)}
              </div>
            ))}

            {results.skipped?.map((s, idx) => (
              <div key={"skip-" + idx} className="flex items-center justify-between text-xs py-1 border-b border-border/10 last:border-0">
                <span className="text-muted truncate max-w-[70%]">
                  {s.title} <span className="text-[10px]">by {s.artist}</span>
                </span>
                <span title={s.reason} className="flex items-center gap-1 text-[10px] text-muted font-semibold uppercase">
                  Skipped
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
