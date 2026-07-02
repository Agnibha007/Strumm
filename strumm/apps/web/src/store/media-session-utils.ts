/**
 * Media Session API utilities for lock-screen / system media controls.
 */
import { Song } from "@strumm/types";
import { getBestArtwork } from "web/lib/media";

/**
 * Update system lockscreen metadata via the Media Session API.
 */
export function updateMediaSession(song: Song, getState: () => any): void {
  if (typeof window !== "undefined" && "mediaSession" in navigator) {
    const artworkSrc = getBestArtwork(song) || song.thumbnail;

    // Force secure thumbnail to prevent mixed content issues
    let secureArtwork = artworkSrc;
    if (secureArtwork && secureArtwork.startsWith("http://")) {
      secureArtwork = secureArtwork.replace("http://", "https://");
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist,
      album: song.metadata?.album || "Strumm",
      artwork: [
        { src: secureArtwork || "", sizes: "96x96", type: "image/jpeg" },
        { src: secureArtwork || "", sizes: "128x128", type: "image/jpeg" },
        { src: secureArtwork || "", sizes: "192x192", type: "image/jpeg" },
        { src: secureArtwork || "", sizes: "256x256", type: "image/jpeg" },
        { src: secureArtwork || "", sizes: "384x384", type: "image/jpeg" },
        { src: secureArtwork || "", sizes: "512x512", type: "image/jpeg" },
      ],
    });

    // Setup system lockscreen media control actions
    navigator.mediaSession.setActionHandler("play", () => {
      const { isPlaying } = getState();
      if (!isPlaying) {
        getState().playerRef?.playVideo();
        getState().setPlaying(true);
      }
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      const { isPlaying } = getState();
      if (isPlaying) {
        getState().playerRef?.pauseVideo();
        getState().setPlaying(false);
      }
    });
    navigator.mediaSession.setActionHandler("previoustrack", () => {
      const { currentTime, prev: prevAction, playerRef } = getState();
      if (currentTime > 5) {
        playerRef?.seekTo(0);
        getState().setCurrentTime(0);
      } else {
        prevAction();
      }
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      getState().next();
    });
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime !== undefined) {
        getState().playerRef?.seekTo(details.seekTime);
        getState().setCurrentTime(details.seekTime);
      }
    });
    navigator.mediaSession.setActionHandler("seekbackward", (details) => {
      const offset = details.seekOffset || 10;
      const targetTime = Math.max(0, getState().currentTime - offset);
      getState().playerRef?.seekTo(targetTime);
      getState().setCurrentTime(targetTime);
    });
    navigator.mediaSession.setActionHandler("seekforward", (details) => {
      const offset = details.seekOffset || 10;
      const targetTime = Math.min(getState().duration, getState().currentTime + offset);
      getState().playerRef?.seekTo(targetTime);
      getState().setCurrentTime(targetTime);
    });
  }
}
