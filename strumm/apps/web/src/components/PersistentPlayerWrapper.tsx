"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import EditorialPlayer from "web/components/EditorialPlayer";
import PlayerStateSync from "web/components/PlayerStateSync";
import AddToHomePrompt from "web/components/AddToHomePrompt";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

const AudioEngine = dynamic(() => import("web/components/AudioEngine"), {
  ssr: false,
});

export default function PersistentPlayerWrapper() {
  const { user, token } = useAuthStore();
  const pathname = usePathname();
  const currentSong = usePlayerStore((state) => state.currentSong);
  const isPodcastSelection = !!currentSong?.videoId?.startsWith("podcast-");
  const [offlineAccess, setOfflineAccess] = useState(false);

  useEffect(() => {
    const allowOfflinePlayback = () => setOfflineAccess(true);
    window.addEventListener("offline", allowOfflinePlayback);
    if (navigator.onLine === false) allowOfflinePlayback();
    return () => window.removeEventListener("offline", allowOfflinePlayback);
  }, []);

  const showPlayerUi = (!!user && !!token) || offlineAccess || isPodcastSelection;
  if (!showPlayerUi && pathname !== "/downloads") return null;

  return (
    <>
      {showPlayerUi && <PlayerStateSync />}
      {showPlayerUi && <EditorialPlayer />}
      <AudioEngine />
      {showPlayerUi && <AddToHomePrompt />}
    </>
  );
}
