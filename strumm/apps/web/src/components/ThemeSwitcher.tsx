"use client";

import { useThemeStore } from "web/store/useThemeStore";
import { ThemeType } from "@strumm/types";
import { Sparkles, Image, Check } from "lucide-react";

export default function ThemeSwitcher() {
  const { currentTheme, setTheme, isAnimated, setAnimated, customImage, setCustomImage } = useThemeStore();

  const themes: Array<{ name: ThemeType; desc: string; preview: string }> = [
    { name: "Obsidian", desc: "True dark obsidian slate.", preview: "bg-[#080808] border-[#222222]" },
    { name: "Black Cherry", desc: "Deep cherry burgundy wash.", preview: "bg-[#0B0505] border-[#3A1F21]" },
    { name: "Vinyl Classic", desc: "Warm retro cardboard sleeves.", preview: "bg-[#0A0A0A] border-[#38302B]" },
    { name: "Ocean Drive", desc: "Midnight blue, neon lights.", preview: "bg-[#03080F] border-[#183354]" },
    { name: "Monochrome", desc: "High contrast pure black/white.", preview: "bg-[#000000] border-[#333333]" },
    { name: "Aurora", desc: "Forest pine, emerald green.", preview: "bg-[#020907] border-[#134E3F]" },
    { name: "Sunset Blvd", desc: "Warm gold, dusk violet tones.", preview: "bg-[#0b0612] border-[#3e1f5c]" },
    { name: "Rose Garden", desc: "Dusty rose and matte pink.", preview: "bg-[#0f070b] border-[#4c1d36]" },
    { name: "Cyberpunk", desc: "Pure neon yellow, neon cyan.", preview: "bg-[#000000] border-[#2e2e38]" },
  ];

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new window.Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          const MAX_WIDTH = 1200;
          const MAX_HEIGHT = 800;
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > MAX_WIDTH) {
              height *= MAX_WIDTH / width;
              width = MAX_WIDTH;
            }
          } else {
            if (height > MAX_HEIGHT) {
              width *= MAX_HEIGHT / height;
              height = MAX_HEIGHT;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            // Compress image to JPEG at 0.6 quality to fit within localStorage limits
            const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
            setCustomImage(dataUrl);
          }
        };
        img.src = event.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-border/20 pb-2">
        <h3 className="font-editorial text-xl text-text flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          Theme Engine
        </h3>
      </div>
      <p className="text-[11px] leading-relaxed text-muted mt-1">
        Select an editorial palette to dress your universe.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {themes.map((t) => (
          <button
            key={t.name}
            onClick={() => setTheme(t.name)}
            title={`Apply the ${t.name} theme: ${t.desc}`}
            className={`flex items-start gap-4 p-4 rounded-lg border text-left cursor-pointer transition-all duration-300 ${
              currentTheme === t.name
                ? "bg-surface-elevated border-primary/40 box-glow"
                : "bg-surface border-border/60 hover:border-muted/50"
            }`}
          >
            <div className={`w-8 h-8 rounded-full border ${t.preview} flex-shrink-0 flex items-center justify-center`}>
              {currentTheme === t.name && <Check className="w-4 h-4 text-primary" />}
            </div>
            <div>
              <div className="font-editorial text-lg leading-none mb-1 text-text">{t.name}</div>
              <div className="text-xs text-muted leading-tight">{t.desc}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="border-t border-border/40 pt-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h3 className="font-editorial text-lg text-text">Custom Space Backdrop</h3>
            <p className="text-xs text-muted">Overlay your workspace with personal imagery.</p>
          </div>
          
          <div className="flex items-center gap-3">
            <label className="py-2 px-4 bg-surface-elevated hover:bg-surface border border-border/80 text-text text-xs rounded-lg flex items-center justify-center gap-2 cursor-pointer transition select-none">
              <Image className="w-3.5 h-3.5 text-primary" />
              Upload Image
              <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
            </label>
            {customImage && (
              <button
                onClick={() => setCustomImage(null)}
                className="text-xs text-primary hover:underline cursor-pointer"
              >
                Reset Image
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border/20 pt-4">
          <div>
            <h3 className="font-editorial text-lg text-text flex items-center gap-2">
              Micro-Animations
            </h3>
            <p className="text-xs text-muted">Toggle fluid motions for lower resource consumption.</p>
          </div>
          <button
            onClick={() => setAnimated(!isAnimated)}
            title={isAnimated ? "Disable fluid animations to save battery and system resources" : "Enable fluid animations for a richer visual experience"}
            className={`px-4 py-1.5 rounded-lg border text-xs cursor-pointer transition ${
              isAnimated
                ? "bg-primary/10 border-primary text-primary"
                : "bg-surface border-border/80 text-muted"
            }`}
          >
            {isAnimated ? "Enabled" : "Disabled (Battery Saver)"}
          </button>
        </div>
      </div>
    </div>
  );
}
