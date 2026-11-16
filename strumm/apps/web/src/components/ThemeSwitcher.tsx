"use client";

import { useThemeStore } from "web/store/useThemeStore";
import { ThemeType } from "@strumm/types";
import { Sparkles, Image, Check, Palette } from "lucide-react";

export default function ThemeSwitcher() {
  const { currentTheme, setTheme, isAnimated, setAnimated, customImage, setCustomImage, customPrimary, customText, setCustomColors } = useThemeStore();
  const isCustom = currentTheme === "Custom";

  const themes: Array<{ name: ThemeType; desc: string; preview: string; custom?: boolean }> = [
    { name: "Obsidian", desc: "High-contrast dark for everyday listening.", preview: "bg-[#050505] border-[#2A2A2A]" },
    { name: "Black Cherry", desc: "Rich, moody reds for late-night sessions.", preview: "bg-[#080203] border-[#3D1A22]" },
    { name: "Vinyl Classic", desc: "Warm retro tones for relaxed playback.", preview: "bg-[#070605] border-[#3A3027]" },
    { name: "Ocean Drive", desc: "Cool neon blues for energetic mixes.", preview: "bg-[#02060C] border-[#163555]" },
    { name: "Monochrome", desc: "Pure black-and-white, maximum clarity.", preview: "bg-[#000000] border-[#3F3F46]" },
    { name: "Aurora", desc: "Fresh greens for calm, immersive listening.", preview: "bg-[#010806] border-[#145741]" },
    { name: "Sunset Blvd", desc: "Warm gold and violet for evening vibes.", preview: "bg-[#09040F] border-[#43245E]" },
    { name: "Rose Garden", desc: "Soft rose tones for a warm, personal feel.", preview: "bg-[#0C0408] border-[#4A1E36]" },
    { name: "Cyberpunk", desc: "High-energy neon for bold, loud sessions.", preview: "bg-[#000000] border-[#2F2F3A]" },
    { name: "Sage Forest", desc: "Earthy greens for focused, mellow listening.", preview: "bg-[#060907] border-[#2D3B32]" },
    { name: "Midnight Amethyst", desc: "Deep violet for immersive night listening.", preview: "bg-[#040208] border-[#352A52]" },
    { name: "Glacial Blue", desc: "Crisp icy blues for clean, bright focus.", preview: "bg-[#03060A] border-[#223044]" },
    { name: "Night Drive", desc: "Cool indigo glow for focused late-night drives.", preview: "bg-[#02040A] border-[#1A2A44]" },
    { name: "Studio Warmth", desc: "Cozy amber tones for intimate, creative listening.", preview: "bg-[#0A0705] border-[#3A2C1F]" },
    { name: "Mint Chill", desc: "Fresh teal palette for calm, refreshing sessions.", preview: "bg-[#030807] border-[#1B3A33]" },
    { name: "Custom", desc: "Your palette — pick colors that match your mood.", preview: "bg-[#0A0C12] border-[#6C8CFF]", custom: true },
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

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-3.5">
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

      {isCustom && (
        <div className="border border-border/50 bg-background/40 rounded-xl p-5 space-y-5 soft-enter">
          <div className="flex items-center gap-2 border-b border-border/20 pb-2">
            <Palette className="w-4 h-4 text-primary" />
            <h3 className="font-editorial text-lg text-text">Custom Palette</h3>
          </div>
          <p className="text-xs text-muted leading-relaxed -mt-2">
            Pick any accent and text color from the full 16.7 million-color RGB range. The background stays a translucent glass so your colors pop over the workspace.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex items-center justify-between gap-3 p-3 rounded-lg bg-surface/40 border border-border/60 cursor-pointer">
              <div>
                <div className="text-sm font-semibold text-text">Accent Color</div>
                <div className="text-[10px] text-muted font-mono uppercase mt-0.5">{customPrimary}</div>
              </div>
              <input
                type="color"
                value={customPrimary}
                onChange={(e) => setCustomColors({ primary: e.target.value })}
                className="w-12 h-9 rounded-md border border-border/60 bg-transparent cursor-pointer"
                title="Choose your accent color (256^3 = 16.7M colors)"
                aria-label="Custom accent color"
              />
            </label>
            <label className="flex items-center justify-between gap-3 p-3 rounded-lg bg-surface/40 border border-border/60 cursor-pointer">
              <div>
                <div className="text-sm font-semibold text-text">Text Color</div>
                <div className="text-[10px] text-muted font-mono uppercase mt-0.5">{customText}</div>
              </div>
              <input
                type="color"
                value={customText}
                onChange={(e) => setCustomColors({ text: e.target.value })}
                className="w-12 h-9 rounded-md border border-border/60 bg-transparent cursor-pointer"
                title="Choose your text color"
                aria-label="Custom text color"
              />
            </label>
          </div>
        </div>
      )}

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
