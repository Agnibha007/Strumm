"use client";

import AuthSystem from "web/components/AuthSystem";
import { useThemeStore } from "web/store/useThemeStore";

export default function LoginPage() {
  const { customImage } = useThemeStore();

  return (
    <div 
      className="min-h-screen bg-background flex items-center justify-center p-4 relative"
      style={customImage ? { backgroundImage: `url(${customImage})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
    >
      {customImage && <div className="absolute inset-0 bg-[#080808]/75 backdrop-blur-md" />}
      <div className="relative z-10 w-full flex justify-center">
        <AuthSystem />
      </div>
    </div>
  );
}
