"use client";

import { useAuthStore } from "web/store/useAuthStore";
import EditorialPlayer from "web/components/EditorialPlayer";
import AudioEngine from "web/components/AudioEngine";
import PlayerStateSync from "web/components/PlayerStateSync";
import AddToHomePrompt from "web/components/AddToHomePrompt";

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
