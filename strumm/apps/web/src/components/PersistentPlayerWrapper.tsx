"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import EditorialPlayer from "web/components/EditorialPlayer";
import PlayerStateSync from "web/components/PlayerStateSync";
import AddToHomePrompt from "web/components/AddToHomePrompt";
import dynamic from "next/dynamic";

const AudioEngine = dynamic(() => import("web/components/AudioEngine"), {
  ssr: false,
});

export default function PersistentPlayerWrapper() {
  const { user, token } = useAuthStore();
  const [offlineAccess, setOfflineAccess] = useState(false);

  useEffect(() => {
    const allowOfflinePlayback = () => setOfflineAccess(true);
    window.addEventListener("offline", allowOfflinePlayback);
    if (navigator.onLine === false) allowOfflinePlayback();
    return () => window.removeEventListener("offline", allowOfflinePlayback);
  }, []);

  if (!user || (!token && !offlineAccess)) return null;

  return (
    <>
      <PlayerStateSync />
      <EditorialPlayer />
      <AudioEngine />
      <AddToHomePrompt />
    </>
  );
}
