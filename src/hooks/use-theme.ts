"use client";

import { useCallback, useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY, type ThemeChoice } from "@/lib/theme";

const CHANGE_EVENT = "outreach-theme-change";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function storedChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function apply(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "system" && window.matchMedia(DARK_QUERY).matches);
  document.documentElement.classList.toggle("dark", dark);
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia(DARK_QUERY);
  const refresh = () => {
    apply(storedChoice());
    onChange();
  };
  media.addEventListener("change", refresh);
  window.addEventListener("storage", refresh);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    media.removeEventListener("change", refresh);
    window.removeEventListener("storage", refresh);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

const isDark = () => document.documentElement.classList.contains("dark");

/** The current theme, plus a toggle that remembers the choice. */
export function useTheme() {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);

  const setTheme = useCallback((choice: ThemeChoice) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, choice);
    } catch {
      // private mode: the choice lasts for this page only
    }
    apply(choice);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const toggle = useCallback(() => setTheme(isDark() ? "light" : "dark"), [setTheme]);

  return { dark, setTheme, toggle };
}
