"use client";

import { useCallback } from "react";
import { formatTime } from "web/lib/format";

interface SeekBarProps {
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
  /** Accessible name for the slider, e.g. "Playback position". */
  label?: string;
  /** Class names for the outer, focusable track. */
  className?: string;
  /** Class names for the filled part of the track. */
  fillClassName?: string;
  /** Keyboard nudge in seconds. */
  stepSeconds?: number;
}

/**
 * Accessible scrubber.
 *
 * The player's timeline used to be a bare `<div onClick>`: no role, no focus
 * target, no keyboard support, and nothing for a screen reader to announce. A
 * mouse was the only way to seek. This wraps the same visual in an ARIA slider
 * with arrow/Home/End/Page keys and a spoken position ("1:23 of 4:07").
 *
 * The visual is unchanged: callers keep their own height and colours.
 */
export default function SeekBar({
  currentTime,
  duration,
  onSeek,
  label = "Playback position",
  className = "",
  fillClassName = "bg-primary",
  stepSeconds = 5,
}: SeekBarProps) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const clampedTime =
    Number.isFinite(currentTime) && currentTime > 0
      ? Math.min(currentTime, safeDuration || currentTime)
      : 0;
  const percent = safeDuration > 0 ? (clampedTime / safeDuration) * 100 : 0;
  const disabled = safeDuration === 0;

  const seek = useCallback(
    (seconds: number) => {
      if (disabled) return;
      onSeek(Math.min(Math.max(seconds, 0), safeDuration));
    },
    [disabled, onSeek, safeDuration],
  );

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    seek(ratio * safeDuration);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        event.preventDefault();
        seek(clampedTime + stepSeconds);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        event.preventDefault();
        seek(clampedTime - stepSeconds);
        break;
      case "PageUp":
        event.preventDefault();
        seek(clampedTime + stepSeconds * 6);
        break;
      case "PageDown":
        event.preventDefault();
        seek(clampedTime - stepSeconds * 6);
        break;
      case "Home":
        event.preventDefault();
        seek(0);
        break;
      case "End":
        event.preventDefault();
        seek(safeDuration);
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(safeDuration)}
      aria-valuenow={Math.round(clampedTime)}
      aria-valuetext={`${formatTime(clampedTime)} of ${formatTime(safeDuration)}`}
      aria-disabled={disabled || undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`relative ${disabled ? "cursor-default opacity-70" : "cursor-pointer"} focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${className}`}
    >
      <div
        style={{ width: `${percent}%` }}
        className={`absolute top-0 bottom-0 left-0 rounded-full ${fillClassName}`}
      />
    </div>
  );
}
