"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useThemeStore } from "web/store/useThemeStore";
import { Music, Play, Radio, Users, Sparkles, Disc, Heart, Volume2 } from "lucide-react";
import { motion } from "framer-motion";

const AuthSystem = dynamic(() => import("web/components/AuthSystem"), {
  loading: () => (
    <div className="w-full max-w-sm mx-auto p-8 bg-surface/30 border border-border/40 rounded-2xl animate-pulse">
      <div className="h-8 w-32 bg-border/40 rounded mb-4" />
      <div className="h-4 w-48 bg-border/30 rounded mb-8" />
      <div className="space-y-3">
        <div className="h-10 bg-border/30 rounded" />
        <div className="h-10 bg-border/30 rounded" />
        <div className="h-10 bg-primary/20 rounded" />
      </div>
    </div>
  ),
  ssr: false,
});

export default function LoginPage() {
  const { customImage } = useThemeStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeTab, setActiveTab] = useState<"features" | "stats">("features");

  // Background Interactive Waveform Animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const handleResize = () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener("resize", handleResize);

    // Audio node simulation
    const waves = [
      { y: 0.5, length: 0.002, amplitude: 120, speed: 0.015, color: "rgba(249, 115, 22, 0.15)" },
      { y: 0.5, length: 0.003, amplitude: 80, speed: 0.02, color: "rgba(251, 146, 60, 0.12)" },
      { y: 0.5, length: 0.001, amplitude: 150, speed: 0.01, color: "rgba(255, 255, 255, 0.06)" },
    ];

    // Particles representing music beats
    const particles: Array<{
      x: number;
      y: number;
      size: number;
      speedX: number;
      speedY: number;
      alpha: number;
      color: string;
    }> = [];

    for (let i = 0; i < 40; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        size: Math.random() * 3 + 1,
        speedX: (Math.random() - 0.5) * 0.5,
        speedY: (Math.random() - 0.5) * 0.5,
        alpha: Math.random() * 0.5 + 0.2,
        color: Math.random() > 0.5 ? "#f97316" : "#fb923c",
      });
    }

    let increment = 0;

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // Draw subtle futuristic background grid
      ctx.strokeStyle = "rgba(255, 255, 255, 0.02)";
      ctx.lineWidth = 1;
      const gridSize = 60;
      for (let x = 0; x < width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Draw waveforms
      waves.forEach((wave) => {
        ctx.beginPath();
        ctx.moveTo(0, height * wave.y);

        for (let i = 0; i < width; i++) {
          const yOffset =
            Math.sin(i * wave.length + increment * wave.speed) *
            wave.amplitude *
            Math.sin(increment * 0.002);
          ctx.lineTo(i, height * wave.y + yOffset);
        }

        ctx.strokeStyle = wave.color;
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      // Draw and animate particles
      particles.forEach((p) => {
        p.x += p.speedX;
        p.y += p.speedY;

        if (p.x < 0 || p.x > width) p.speedX *= -1;
        if (p.y < 0 || p.y > height) p.speedY *= -1;

        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.shadowBlur = 10;
        ctx.shadowColor = p.color;
        ctx.fill();
        ctx.restore();
      });

      increment += 1;
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <div
      className="min-h-screen bg-[#080808] text-white flex items-center justify-center p-4 relative overflow-hidden"
      style={
        customImage
          ? { backgroundImage: `url(${customImage})`, backgroundSize: "cover", backgroundPosition: "center" }
          : {}
      }
    >
      {/* Absolute Overlays */}
      <canvas ref={canvasRef} className="absolute inset-0 z-0 pointer-events-none" />
      <div className="absolute inset-0 bg-gradient-to-tr from-[#080808] via-[#0b0c10]/95 to-[#161224]/40 z-0" />
      {customImage && <div className="absolute inset-0 bg-[#080808]/80 backdrop-blur-lg z-0" />}

      {/* Main Container */}
      <div className="relative z-10 w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-center px-4 py-8">
        
        {/* Left Side: Strumm Interactive Showcase */}
        <div className="lg:col-span-7 space-y-8 flex flex-col justify-center text-left">
          
          {/* Animated Badge */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 px-3 py-1 bg-white/5 border border-white/10 rounded-full w-fit hover:bg-white/10 hover:border-primary/50 transition duration-300 cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-primary animate-pulse" />
            <span className="text-[10px] tracking-widest uppercase font-semibold text-primary-hover">
              Introducing Strumm 2.0
            </span>
          </motion.div>

          {/* Hero Headline */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="space-y-4"
          >
            <h1 className="text-4xl sm:text-6xl font-editorial font-bold tracking-tight leading-[1.1] text-white">
              Your music. <br />
              Your memories. <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">Your world.</span>
            </h1>
            <p className="text-sm sm:text-base text-muted max-w-lg leading-relaxed">
              Listen freely, discover your sound, and create a home for every song you love.
            </p>
          </motion.div>

          {/* Interactive Feature Panel */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="bg-surface/30 backdrop-blur-md border border-border/20 rounded-2xl p-6 space-y-4 max-w-xl shadow-xl hover:border-primary/30 transition duration-500"
          >
            {/* Tabs */}
            <div className="flex gap-4 border-b border-border/20 pb-3">
              <button
                onClick={() => setActiveTab("features")}
                className={`text-xs uppercase tracking-widest font-semibold pb-1 transition relative ${
                  activeTab === "features" ? "text-primary" : "text-muted hover:text-text"
                }`}
              >
                Features
                {activeTab === "features" && (
                  <motion.div
                    layoutId="activeTabUnderline"
                    className="absolute -bottom-[13px] left-0 right-0 h-[2px] bg-primary"
                  />
                )}
              </button>
              <button
                onClick={() => setActiveTab("stats")}
                className={`text-xs uppercase tracking-widest font-semibold pb-1 transition relative ${
                  activeTab === "stats" ? "text-primary" : "text-muted hover:text-text"
                }`}
              >
                Technology
                {activeTab === "stats" && (
                  <motion.div
                    layoutId="activeTabUnderline"
                    className="absolute -bottom-[13px] left-0 right-0 h-[2px] bg-primary"
                  />
                )}
              </button>
            </div>

            {/* Tab content */}
            <div className="min-h-[140px] flex flex-col justify-center">
              {activeTab === "features" ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex items-start gap-3 group">
                    <div className="p-2 bg-primary/10 border border-primary/20 rounded-lg group-hover:bg-primary/20 transition duration-300">
                      <Music className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-text">Endless Music</h4>
                      <p className="text-[11px] text-muted mt-0.5">Millions of songs. No interruptions. Just your music.</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 group">
                    <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg group-hover:bg-emerald-500/20 transition duration-300">
                      <Sparkles className="w-4 h-4 text-emerald-400" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-text">Strumm Flow</h4>
                      <p className="text-[11px] text-muted mt-0.5">Discover playlists shaped around your mood, memories, and taste.</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 group">
                    <div className="p-2 bg-accent/10 border border-accent/20 rounded-lg group-hover:bg-accent/20 transition duration-300">
                      <Users className="w-4 h-4 text-accent" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-text">Strumm Circle</h4>
                      <p className="text-[11px] text-muted mt-0.5">Listen together, share your taste, and discover with friends.</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 group">
                    <div className="p-2 bg-rose-500/10 border border-rose-500/20 rounded-lg group-hover:bg-rose-500/20 transition duration-300">
                      <Heart className="w-4 h-4 text-rose-400" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-text">Live Lyrics</h4>
                      <p className="text-[11px] text-muted mt-0.5">Follow every moment with beautiful synced lyrics.</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-white/5 border border-white/10 rounded-lg">
                      <Disc className="w-4 h-4 text-muted" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-text">Next.js Framework</h4>
                      <p className="text-[11px] text-muted mt-0.5">Optimized React runtime supporting fast client transitions.</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-white/5 border border-white/10 rounded-lg">
                      <Volume2 className="w-4 h-4 text-muted" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-text">Web Audio API</h4>
                      <p className="text-[11px] text-muted mt-0.5">Hardware accelerated rendering with real-time waveform processing.</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-white/5 border border-white/10 rounded-lg">
                      <Radio className="w-4 h-4 text-muted" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-text">Resend API Verifier</h4>
                      <p className="text-[11px] text-muted mt-0.5">Password-based secure authorization with instant signup OTP.</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-white/5 border border-white/10 rounded-lg">
                      <Play className="w-4 h-4 text-muted" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-text">Hashed Cryptography</h4>
                      <p className="text-[11px] text-muted mt-0.5">Secure pbkdf2 algorithm protecting credentials offline.</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </div>

        {/* Right Side: Auth Form Container */}
        <div className="lg:col-span-5 flex justify-center lg:justify-end">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="w-full flex justify-center"
          >
            <AuthSystem />
          </motion.div>
        </div>
      </div>
    </div>
  );
}
