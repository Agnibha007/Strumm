"use client";

import { useState } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Sparkles, Music, AlertCircle } from "lucide-react";
import { Song } from "@strumm/types";
import { apiUrl, cleanText } from "web/lib/api";

const MOODS = [
  { id: "Chill", label: "Chill", desc: "For slow afternoons and calm winds." },
  { id: "Focus", label: "Focus", desc: "Clean geometric sounds for flow state." },
  { id: "Energetic", label: "Energetic", desc: "Pulsing audio to charge your battery." },
  { id: "Sad", label: "Melancholic", desc: "Poetic textures for rain on glass." },
  { id: "Creative", label: "Creative", desc: "Unconventional patterns to prompt ideas." },
];

export default function SmartFlow() {
  const [selectedMood, setSelectedMood] = useState("Focus");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { playSong, setQueue } = usePlayerStore();

  const generateFlow = async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetching from FastAPI backend endpoint
      const response = await fetch(apiUrl(`/flow?mood=${encodeURIComponent(cleanText(selectedMood, 80))}`), {
        headers: {
          // Send mock token to satisfy JWT verification
          "Authorization": `Bearer ${localStorage.getItem("strumm-token") || ""}`
        }
      });
      
      const json = await response.json();
      if (json.success && json.data?.songs?.length > 0) {
        const songs: Song[] = json.data.songs;
        setQueue(songs);
        playSong(songs[0], songs);
      } else {
        setError(json.error || "Failed to load flow curation. Database might be empty.");
      }
    } catch (e) {
      setError("Unable to connect to Strumm API. Please run the backend service.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-6">
      <div className="flex items-center justify-between border-b border-border/20 pb-4">
        <div>
          <h2 className="text-xl font-editorial text-text flex items-center gap-2">
            Listening Flow
          </h2>
          <p className="text-xs text-muted">Generate dynamic curation adapted to your vibe.</p>
        </div>
        <Sparkles className="w-5 h-5 text-primary text-glow" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {MOODS.map((m) => (
          <button
            key={m.id}
            onClick={() => setSelectedMood(m.id)}
            className={`p-4 rounded-lg border text-left cursor-pointer transition ${
              selectedMood === m.id
                ? "bg-surface-elevated border-primary/50 text-text"
                : "bg-background/40 border-border/40 hover:border-muted/30 text-muted hover:text-text"
            }`}
          >
            <div className="font-editorial text-base text-text mb-1">{m.label}</div>
            <div className="text-[11px] leading-snug">{m.desc}</div>
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded-lg">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button
        onClick={generateFlow}
        disabled={loading}
        className="w-full py-3 bg-primary hover:bg-primary-hover text-white font-editorial text-base font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-55"
      >
        <Music className="w-4 h-4" />
        {loading ? "Aligning frequencies..." : `Activate ${selectedMood} Flow`}
      </button>
    </div>
  );
}
