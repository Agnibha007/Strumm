export interface LyricLine {
  time: number;
  text: string;
}

function parseTimestamp(minutes: string, seconds: string, fraction?: string) {
  const mins = Number.parseInt(minutes, 10);
  const secs = Number.parseInt(seconds, 10);
  const rawFraction = fraction || "0";
  const divisor = rawFraction.length === 3 ? 1000 : rawFraction.length === 2 ? 100 : 10;

  return mins * 60 + secs + Number.parseInt(rawFraction, 10) / divisor;
}

export function parseLrc(lrcString: string): LyricLine[] {
  const parsed: LyricLine[] = [];
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const offsetMatch = /\[offset:([+-]?\d+)\]/i.exec(lrcString);
  const offsetSeconds = offsetMatch ? Number.parseInt(offsetMatch[1], 10) / 1000 : 0;

  for (const line of lrcString.split(/\r?\n/)) {
    const timestamps = [...line.matchAll(timeRegex)];
    if (timestamps.length === 0) continue;

    const text = line.replace(timeRegex, "").trim();
    if (!text) continue;

    for (const timestamp of timestamps) {
      const time = Math.max(
        0,
        parseTimestamp(timestamp[1], timestamp[2], timestamp[3]) + offsetSeconds
      );
      parsed.push({ time, text });
    }
  }

  return parsed.sort((a, b) => a.time - b.time);
}

export function getActiveLyricIndex(lyrics: LyricLine[] | null, currentTime: number) {
  if (!lyrics?.length) return -1;

  let activeIndex = -1;
  for (let i = 0; i < lyrics.length; i += 1) {
    if (currentTime >= lyrics[i].time) {
      activeIndex = i;
    } else {
      break;
    }
  }
  return activeIndex;
}
