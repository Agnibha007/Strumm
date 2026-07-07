"use client";

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

  if (!user || !token) return null;

  return (
    <>
      <PlayerStateSync />
      <EditorialPlayer />
      <AudioEngine />
      <AddToHomePrompt />
    </>
  );
}
