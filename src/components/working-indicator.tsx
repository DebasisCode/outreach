"use client";

import { useEffect, useState } from "react";

const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

/**
 * Claude Code's working line: a turning glyph, what's happening, how long it
 * has taken, and how to interrupt. Mount it with a new key per turn.
 */
export function WorkingIndicator({ label, interruptKey }: { label: string; interruptKey: string }) {
  const [frame, setFrame] = useState(0);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setFrame((value) => value + 1);
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 120);
    return () => clearInterval(timer);
  }, []);

  return (
    <div aria-live="polite" className="flex items-center gap-2 font-mono text-sm" role="status">
      <span aria-hidden className="w-3 text-center text-[#d97757]">
        {GLYPHS[frame % GLYPHS.length]}
      </span>
      <span className="thinking-shimmer font-medium">{label}…</span>
      <span className="text-muted-foreground text-xs">
        ({seconds}s · {interruptKey} to interrupt)
      </span>
    </div>
  );
}
