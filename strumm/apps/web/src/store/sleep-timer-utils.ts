/**
 * Sleep timer utilities extracted from usePlayerStore.
 *
 * The sleep timer allows users to set a timer that pauses playback after
 * a fixed duration (15, 30, 45, 60 min) or at the end of the current track.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SleepTimerDuration = 15 | 30 | 45 | 60 | "end-of-track" | null;

export interface SleepTimerState {
  sleepTimerDuration: SleepTimerDuration;
  sleepTimerEndTime: number | null;
}

export interface SleepTimerActions {
  setSleepTimer: (duration: SleepTimerDuration) => void;
  clearSleepTimer: () => void;
  checkSleepTimer: () => void;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export const initialSleepTimerState: SleepTimerState = {
  sleepTimerDuration: null,
  sleepTimerEndTime: null,
};

// ---------------------------------------------------------------------------
// Action factories (call from the store)
// ---------------------------------------------------------------------------

export function createSleepTimerActions(
  set: (partial: Partial<Record<string, any>>) => void,
  get: () => any,
): SleepTimerActions {
  return {
    setSleepTimer: (duration: SleepTimerDuration) => {
      const { duration: songDuration } = get();
      if (!duration) {
        set({ sleepTimerDuration: null, sleepTimerEndTime: null });
        return;
      }

      let endTime: number;
      if (duration === "end-of-track") {
        const remaining = Math.max(0, songDuration - get().currentTime);
        endTime = Date.now() + remaining * 1000;
      } else {
        endTime = Date.now() + duration * 60 * 1000;
      }

      set({
        sleepTimerDuration: duration,
        sleepTimerEndTime: endTime,
      });
    },

    clearSleepTimer: () => {
      set({ sleepTimerDuration: null, sleepTimerEndTime: null });
    },

    checkSleepTimer: () => {
      const { sleepTimerEndTime, isPlaying, togglePlay } = get();
      if (sleepTimerEndTime && isPlaying && Date.now() >= sleepTimerEndTime) {
        togglePlay();
        set({ sleepTimerDuration: null, sleepTimerEndTime: null });
      }
    },
  };
}
