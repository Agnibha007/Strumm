"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Sparkles, Play, Music, CheckCircle2, ListMusic } from "lucide-react";
import { apiUrl } from "web/lib/api";
import { Song } from "@strumm/types";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useAuthStore } from "web/store/useAuthStore";
import { useNotificationStore } from "web/store/useNotificationStore";
import SongArtwork from "./SongArtwork";

interface ChatMessage {
  sender: "user" | "ai";
  text: string;
  songs?: Song[];
  playlist?: {
    id: string;
    name: string;
    songs_count: number;
  } | null;
  edit_playlist?: boolean;
  playlist_id?: string;
  songs_to_add?: any[];
  songs_to_remove?: any[];
  requires_confirmation?: boolean;
  action_confirmed?: boolean;
  action_cancelled?: boolean;
}

const STARTER_PROMPTS = [
  "Make a dark synthwave playlist",
  "Recommend 5 indie rock tracks",
  "Create a workout playlist",
  "Suggest songs for a rainy day",
];

export default function AICuratorChat({ fullPage = false }: { fullPage?: boolean }) {
  const token = useAuthStore((s) => s.token);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      sender: "ai",
      text: "Hello! I am Strumm Flow, your personal music curator. I can recommend tracks based on your mood, answer music questions, or dynamically build smart playlists directly in your library (e.g., 'Make a playlist for rain'). What are you in the mood for?",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [secondConfirmIdx, setSecondConfirmIdx] = useState<number | null>(null);
  const { playSong } = usePlayerStore();
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const submitPrompt = async (raw: string) => {
    const userText = raw.trim();
    if (!userText || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { sender: "user", text: userText }]);
    setLoading(true);

    try {
      // Map history excluding the first assistant greeting
      const historyPayload = messages.slice(1).map(m => ({
        role: m.sender === "user" ? "user" : "assistant",
        content: m.text
      }));

      const response = await fetch(apiUrl("/explore-chat"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": token ? `Bearer ${token}` : "",
        },
        credentials: "include",
        body: JSON.stringify({
          prompt: userText,
          history: historyPayload
        }),
      });

      const json = await response.json();
      if (json.success && json.data) {
        setMessages((prev) => [
          ...prev,
          {
            sender: "ai",
            text: json.data.message,
            songs: json.data.songs,
            playlist: json.data.playlist,
            edit_playlist: json.data.edit_playlist,
            playlist_id: json.data.playlist_id,
            songs_to_add: json.data.songs_to_add,
            songs_to_remove: json.data.songs_to_remove,
            requires_confirmation: json.data.requires_confirmation
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            sender: "ai",
            text: json.error || "Sorry, I ran into an error while processing your request. Please try again.",
          },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          sender: "ai",
          text: "I couldn't reach the curation server. Please check your internet connection.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    submitPrompt(input);
  };

  const handleConfirmEdit = async (msgIdx: number) => {
    const msg = messages[msgIdx];
    if (!msg || loading) return;

    setLoading(true);
    try {
      const response = await fetch(apiUrl("/explore-chat"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": token ? `Bearer ${token}` : "",
        },
        credentials: "include",
        body: JSON.stringify({
          prompt: "Confirm edit playlist",
          confirm_edit: true,
          playlist_id: msg.playlist_id,
          songs_to_add: msg.songs_to_add,
          songs_to_remove: msg.songs_to_remove
        }),
      });

      const json = await response.json();
      if (json.success && json.data) {
        // Mark as confirmed in state
        setMessages(prev => prev.map((m, idx) => idx === msgIdx ? {
          ...m,
          action_confirmed: true,
          text: json.data.message
        } : m));
      } else {
        useNotificationStore.getState().show(json.error || "Failed to update playlist.", "error");
      }
    } catch (err) {
      useNotificationStore.getState().show("Failed to connect to backend server.", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleCancelEdit = (msgIdx: number) => {
    setMessages(prev => prev.map((m, idx) => idx === msgIdx ? { ...m, action_cancelled: true } : m));
  };

  const isFirstMessage = messages.length <= 1;

  return (
    <div className={`bg-surface/10 border border-border/40 rounded-2xl shadow-xl backdrop-blur-lg flex flex-col ${
      fullPage ? "p-2 md:p-6 h-[60vh] md:h-[70vh] w-full" : "p-5 h-[400px] mt-4 bg-surface/30 shadow-sm backdrop-blur-md"
    }`}>
      {!fullPage && (
        <div className="flex items-center gap-2 border-b border-border/20 pb-3 mb-3">
          <Sparkles className="w-4 h-4 text-primary animate-pulse" />
          <h4 className="font-editorial text-sm font-bold text-text">Ask Strumm Flow</h4>
        </div>
      )}

      {/* Messages list */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-1 scrollbar-thin scrollbar-thumb-border/40 scrollbar-track-transparent">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex flex-col max-w-[85%] ${
              msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start"
            }`}
          >
            <div
              className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                msg.sender === "user"
                  ? "bg-primary text-background font-semibold rounded-br-none"
                  : "bg-surface-elevated border border-border/40 text-text rounded-bl-none"
              }`}
            >
              {msg.text}
            </div>

            {/* If AI recommended songs */}
            {msg.songs && msg.songs.length > 0 && (
              <div className="mt-2.5 w-full bg-surface-elevated/50 border border-border/20 rounded-xl p-2.5 space-y-2">
                <div className="flex items-center justify-between px-1 pb-1.5 border-b border-border/10">
                  <div className="text-[11px] uppercase tracking-wider text-muted font-bold flex items-center gap-1.5">
                    <Music className="w-3 h-3 text-primary" /> Recommended Curation
                  </div>
                  <button
                    onClick={() => msg.songs && msg.songs.length > 0 && playSong(msg.songs[0], msg.songs)}
                    className="flex items-center gap-1 text-[11px] font-bold text-primary hover:text-accent transition cursor-pointer"
                  >
                    <Play className="w-3 h-3" /> Play all
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-1.5 max-h-[160px] overflow-y-auto pr-0.5 scrollbar-thin">
                  {msg.songs.map((song) => (
                    <button
                      key={song.videoId}
                      onClick={() => playSong(song, msg.songs || [])}
                      className="group flex items-center gap-2.5 p-1.5 rounded-lg hover:bg-surface hover:ring-1 hover:ring-primary/40 text-left w-full cursor-pointer transition"
                    >
                      <div className="relative flex-shrink-0">
                        <SongArtwork song={song} className="w-9 h-9 rounded" />
                        <div className="absolute inset-0 flex items-center justify-center rounded bg-black/50 opacity-0 group-hover:opacity-100 transition">
                          <Play className="w-3.5 h-3.5 text-white fill-white" />
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-text truncate">{song.title}</div>
                        <div className="text-[10px] text-muted truncate mt-0.5">{song.artist}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* If AI created a playlist */}
            {msg.playlist && (
              <div className="mt-2 w-full bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-2.5 flex items-start gap-2.5 text-xs text-emerald-400">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold text-[11px] text-emerald-300">Smart Playlist Created</div>
                  <div className="mt-0.5 text-xs text-muted">
                    &quot;{msg.playlist.name}&quot; was saved into your library with {msg.playlist.songs_count} tracks.
                  </div>
                </div>
              </div>
            )}

            {/* If playlist edit requires confirmation */}
            {msg.edit_playlist && !msg.action_confirmed && !msg.action_cancelled && (
              <div className="mt-2.5 w-full bg-primary/10 border border-primary/20 rounded-xl p-3.5 space-y-2.5 text-xs">
                {secondConfirmIdx === idx ? (
                  <>
                    <div className="font-bold text-[12px] text-red-400 flex items-center gap-1.5 animate-pulse">
                      <ListMusic className="w-4 h-4" /> Second Confirmation Required
                    </div>
                    <p className="text-xs text-muted leading-relaxed font-semibold">
                      Warning: You are about to edit/overwrite pre-made playlist content. This will alter your previously created playlist. Are you absolutely sure?
                    </p>
                    <div className="flex gap-2 justify-end pt-1">
                      <button
                        onClick={() => {
                          setSecondConfirmIdx(null);
                          handleConfirmEdit(idx);
                        }}
                        disabled={loading}
                        className="px-3 py-1.5 bg-red-500 text-white font-editorial font-bold text-[11px] rounded-lg hover:bg-red-600 transition cursor-pointer disabled:opacity-50"
                      >
                        Yes, Modify Pre-made Playlist
                      </button>
                      <button
                        onClick={() => setSecondConfirmIdx(null)}
                        disabled={loading}
                        className="px-3 py-1.5 border border-border text-muted text-[11px] rounded-lg hover:bg-surface transition cursor-pointer"
                      >
                        Go Back
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-bold text-[12px] text-primary flex items-center gap-1.5">
                      <ListMusic className="w-4 h-4" /> Action Confirmation Required
                    </div>
                    <p className="text-xs text-muted leading-relaxed">
                      Strumm Flow requests permission to edit your playlist.
                      {msg.songs_to_add && msg.songs_to_add.length > 0 && ` Will add ${msg.songs_to_add.length} tracks.`}
                      {msg.songs_to_remove && msg.songs_to_remove.length > 0 && ` Will remove ${msg.songs_to_remove.length} tracks.`}
                    </p>
                    <div className="flex gap-2 justify-end pt-1">
                      <button
                        onClick={() => {
                          if (msg.requires_confirmation) {
                            setSecondConfirmIdx(idx);
                          } else {
                            handleConfirmEdit(idx);
                          }
                        }}
                        disabled={loading}
                        className="px-3 py-1.5 bg-primary text-background font-editorial font-bold text-[11px] rounded-lg hover:opacity-95 transition cursor-pointer disabled:opacity-50"
                      >
                        Confirm Edit
                      </button>
                      <button
                        onClick={() => handleCancelEdit(idx)}
                        disabled={loading}
                        className="px-3 py-1.5 border border-border text-muted text-[11px] rounded-lg hover:bg-surface transition cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            
            {msg.edit_playlist && msg.action_confirmed && (
              <div className="mt-2 w-full bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-2.5 flex items-start gap-2.5 text-xs text-emerald-400">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold text-[11px] text-emerald-300">Playlist Updated</div>
                  <div className="mt-0.5 text-xs text-muted">
                    Playlist was modified successfully.
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-1.5 bg-surface-elevated border border-border/40 rounded-2xl rounded-bl-none px-4 py-3 w-fit">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Starter prompt chips */}
      {isFirstMessage && !loading && (
        <div className="mt-3 flex flex-wrap gap-2">
          {STARTER_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              onClick={() => submitPrompt(prompt)}
              className="px-3 py-1.5 bg-surface-elevated border border-border/40 text-[11px] text-muted hover:text-text hover:border-primary/40 rounded-full transition cursor-pointer"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      {/* Input box */}
      <form onSubmit={handleSend} className="mt-3 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g., 'Make a dark synthwave playlist'"
          className="flex-1 bg-surface-elevated border border-border rounded-xl px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="p-2.5 bg-accent hover:opacity-90 disabled:opacity-40 text-background rounded-xl cursor-pointer transition-all flex items-center justify-center"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}
