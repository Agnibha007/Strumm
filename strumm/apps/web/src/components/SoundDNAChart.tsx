import type { SoundDNA } from "@strumm/types";

export function SoundDNABar({ value, label }: { value: number; label: string }) {
  const filled = "█".repeat(value);
  const empty = "░".repeat(Math.max(0, 10 - value));

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] font-semibold">
        <span className="text-text/90">{label}</span>
        <span className="text-primary">{value * 10}%</span>
      </div>
      <div className="font-mono text-primary text-xs tracking-wider select-none">
        {filled}
        {empty}
      </div>
    </div>
  );
}

const SOUND_DNA_LABELS: Array<{ key: keyof SoundDNA; label: string }> = [
  { key: "energy", label: "Energy" },
  { key: "discovery", label: "Discovery" },
  { key: "nostalgia", label: "Nostalgia" },
  { key: "variety", label: "Variety" },
  { key: "repeatRate", label: "Repeat Rate" },
];

export default function SoundDNAChart({ soundDNA }: { soundDNA: SoundDNA }) {
  return (
    <div className="space-y-3">
      {SOUND_DNA_LABELS.map(({ key, label }) => (
        <SoundDNABar key={key} value={soundDNA[key]} label={label} />
      ))}
    </div>
  );
}
