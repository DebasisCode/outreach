"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * App-wide keyboard shortcuts. One window listener; handlers always see the
 * latest props. A handler that ran prevents the browser's default (e.g.
 * Ctrl+0's zoom reset) unless `keepDefault` is set.
 */
export interface Hotkey {
  /** "mod+k", "alt+arrowup", "escape", "/" — mod is ⌘ on a Mac, Ctrl elsewhere. */
  combo: string;
  run: (event: KeyboardEvent) => void;
  /** Fire while typing in a text field too. Default: only for mod/alt combos. */
  inInputs?: boolean;
  /** Skip unless this returns true. */
  when?: () => boolean;
  /** Let the key do its normal thing as well (e.g. "/" types a slash). */
  keepDefault?: boolean;
}

const isMacPlatform = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

const noSubscription = () => () => {};

export function useIsMac(): boolean {
  return useSyncExternalStore(noSubscription, isMacPlatform, () => false);
}

function matches(combo: string, event: KeyboardEvent, mac: boolean): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop();
  const mod = mac ? event.metaKey : event.ctrlKey;
  const otherMod = mac ? event.ctrlKey : event.metaKey;
  return (
    !otherMod &&
    mod === parts.includes("mod") &&
    event.altKey === parts.includes("alt") &&
    event.shiftKey === parts.includes("shift") &&
    event.key.toLowerCase() === key
  );
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function useHotkeys(hotkeys: Hotkey[]): void {
  const latest = useRef(hotkeys);
  useEffect(() => {
    latest.current = hotkeys;
  });

  useEffect(() => {
    const mac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      for (const hotkey of latest.current) {
        if (!matches(hotkey.combo, event, mac)) continue;
        const hasModifier = /(^|\+)(mod|alt)\+/.test(hotkey.combo.toLowerCase());
        if (isTyping(event.target) && !(hotkey.inInputs ?? hasModifier)) continue;
        if (hotkey.when && !hotkey.when()) continue;
        if (!hotkey.keepDefault) event.preventDefault();
        hotkey.run(event);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
