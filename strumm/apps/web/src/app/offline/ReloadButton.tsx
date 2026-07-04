"use client";

export default function ReloadButton() {
  return (
    <button
      onClick={() => window.location.reload()}
      className="inline-block px-6 py-2.5 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-bold rounded-lg transition"
    >
      Try Reconnecting
    </button>
  );
}
