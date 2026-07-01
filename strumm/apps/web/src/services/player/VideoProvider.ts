/**
 * VideoProvider — abstract interface for video playback providers.
 *
 * Each provider implements the same contract so the rest of the application
 * never calls YouTube-specific logic directly.  This makes it trivial to
 * add future providers (e.g. Vimeo, Dailymotion, self-hosted MP4).
 *
 * The provider is responsible for:
 *   - Rendering the video player DOM element
 *   - Controlling playback (play, pause, seek)
 *   - Reporting state changes (playing, paused, ended, buffering)
 *   - Reporting time/duration updates
 *   - Exposing volume and playback rate controls
 *
 * Usage in the player hierarchy:
 *   AudioEngine (audio) ↔ YouTubeVideoPlayer (video via VideoProvider)
 *
 * When videoMode is active, AudioEngine yields control to the
 * VideoProvider-based player component.
 */

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface VideoProviderActions {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number) => void;
  setVolume: (volume: number) => void;
  setPlaybackRate: (rate: number) => void;
  setPlaybackQuality?: (quality: string) => void;
  destroy: () => void;
}

export interface VideoProviderProps {
  videoId: string;
  startSeconds?: number;
  isPlaying: boolean;
  volume: number;
  playbackRate: number;
  playbackQuality?: string;
  onReady: () => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  onTimeUpdate: (currentTime: number) => void;
  onDurationChange: (duration: number) => void;
  onError: (error: string) => void;
  onBuffering: (isBuffering: boolean) => void;
  /** Called once the player instance is created so the parent can store the ref. */
  onActionsReady: (actions: VideoProviderActions) => void;
}

export type VideoProviderComponent = React.ComponentType<VideoProviderProps>;
