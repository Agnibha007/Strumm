"use client";

import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { useThemeStore } from "web/store/useThemeStore";

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

  // Background Interactive Waveform Animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Micro-Animations disabled → skip the rAF loop entirely (battery saver)
    if (!useThemeStore.getState().isAnimated) return;

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

      {/* Auth Form Container */}
      <div className="relative z-10 w-full flex justify-center py-8">
        <AuthSystem />
      </div>
    </div>
  );
}
