"use client";

import { useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import ThemeSwitcher from "web/components/ThemeSwitcher";
import { User, Image, Save, AlertCircle, CheckCircle2, Upload, Gauge, Wifi, WifiLow, Zap } from "lucide-react";
import { apiUrl, cleanText } from "web/lib/api";

const QUALITY_OPTIONS = [
  {
    id: "data-saver",
    label: "Data Saver",
    detail: "Lower video quality and lighter media preload.",
    icon: WifiLow,
  },
  {
    id: "balanced",
    label: "Balanced",
    detail: "Default quality for everyday listening.",
    icon: Gauge,
  },
  {
    id: "high",
    label: "High",
    detail: "Prefer higher YouTube video quality when available.",
    icon: Zap,
  },
] as const;

export default function SettingsPage() {
  const { user, token, setUser } = useAuthStore();
  const { audioQuality, setAudioQuality } = usePlayerStore();
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [avatar, setAvatar] = useState(user?.avatar || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 1.5 * 1024 * 1024) {
      setError("File size must be less than 1.5MB.");
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        setAvatar(reader.result);
        setError(null);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch(apiUrl("/profile"), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          displayName: cleanText(displayName, 120),
          avatar: avatar.startsWith("data:image/") ? avatar : cleanText(avatar, 1500)
        })
      });

      const json = await response.json();
      if (json.success && json.data) {
        setUser(json.data); // sync Zustand state
        setSuccess("Profile settings updated successfully.");
      } else {
        setError(json.error || "Failed to update profile.");
      }
    } catch (e) {
      setError("Unable to connect to backend server.");
    } finally {
      setLoading(false);
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-10">
      {/* Header */}
      <div>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Control Panel
        </span>
        <h2 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          Settings
        </h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Profile forms and account settings */}
        <div className="lg:col-span-6 bg-surface border border-border/60 rounded-xl p-6 space-y-6">
          <div>
            <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
              Profile Manager
            </h3>
          </div>

          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">
                Display Name
              </label>
              <div className="relative">
                <User className="absolute left-3.5 top-3.5 w-4 h-4 text-muted" />
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your display username"
                  className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">
                Profile Picture (Link or Upload)
              </label>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-grow">
                  <Image className="absolute left-3.5 top-3.5 w-4 h-4 text-muted" />
                  <input
                    type="text"
                    value={avatar.startsWith("data:image/") ? "[Uploaded Base64 Image]" : avatar}
                    onChange={(e) => {
                      if (!e.target.value.startsWith("[Uploaded")) {
                        setAvatar(e.target.value);
                      }
                    }}
                    placeholder="https://example.com/avatar.jpg"
                    className="w-full bg-background border border-border rounded-lg pl-10 pr-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition text-xs font-mono"
                  />
                </div>
                <div className="relative flex-shrink-0">
                  <label className="py-2.5 px-4 bg-surface-elevated hover:bg-surface border border-border/80 text-text text-xs rounded-lg flex items-center justify-center gap-2 cursor-pointer transition select-none">
                    <Upload className="w-3.5 h-3.5 text-primary" />
                    Upload Image
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
              {avatar.startsWith("data:image/") && (
                <div className="mt-2 flex items-center gap-3">
                  <img src={avatar} alt="Preview" loading="lazy" decoding="async" className="w-12 h-12 rounded-full object-cover border border-primary shadow" />
                  <button
                    type="button"
                    onClick={() => setAvatar("")}
                    className="text-[10px] text-primary hover:underline font-semibold"
                  >
                    Remove uploaded image
                  </button>
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-center gap-2 text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded-lg">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {success && (
              <div className="flex items-center gap-2 text-xs text-emerald-500 bg-emerald-500/5 border border-emerald-500/20 p-3 rounded-lg">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>{success}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-text hover:bg-white text-background font-editorial text-sm font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50"
            >
              <Save className="w-4 h-4 text-background" />
              {loading ? "Saving settings..." : "Save Profile Details"}
            </button>
          </form>

        </div>

        {/* Right: Theme Switcher component */}
        <div className="lg:col-span-6 space-y-6">
          <div className="bg-surface/30 border border-border/40 p-6 rounded-xl space-y-5">
            <div>
              <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2 flex items-center gap-2">
                <Wifi className="w-4 h-4 text-primary" />
                Audio Quality
              </h3>
            </div>

            <div className="grid gap-3">
              {QUALITY_OPTIONS.map((option) => {
                const Icon = option.icon;
                const selected = audioQuality === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setAudioQuality(option.id)}
                    title={`Set streaming and preloading quality to ${option.label}: ${option.detail}`}
                    className={`w-full text-left border rounded-lg p-4 transition cursor-pointer flex items-start gap-3 ${
                      selected
                        ? "border-primary bg-primary/10 text-text"
                        : "border-border/60 bg-background/40 hover:border-border text-muted hover:text-text"
                    }`}
                  >
                    <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${selected ? "text-primary" : "text-muted"}`} />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="block text-[11px] leading-relaxed mt-1 text-muted">
                        {option.detail}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="bg-surface/30 border border-border/40 p-6 rounded-xl">
            <ThemeSwitcher />
          </div>
        </div>
      </div>
    </div>
  );
}
