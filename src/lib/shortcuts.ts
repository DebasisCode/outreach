/**
 * Keyboard shortcuts, listed once for the shortcuts panel and the palette.
 * "mod" is ⌘ on a Mac and Ctrl elsewhere.
 */
export interface ShortcutInfo {
  keys: string[];
  label: string;
  group: "App" | "Chat box" | "Email approval";
}

export const SHORTCUTS: ShortcutInfo[] = [
  { keys: ["mod", "0"], label: "New chat", group: "App" },
  { keys: ["mod", "K"], label: "Command palette", group: "App" },
  { keys: ["mod", "B"], label: "Show or hide the sidebar", group: "App" },
  { keys: ["mod", "/"], label: "Keyboard shortcuts", group: "App" },
  { keys: ["mod", ","], label: "API keys", group: "App" },
  { keys: ["alt", "↑"], label: "Previous chat", group: "App" },
  { keys: ["alt", "↓"], label: "Next chat", group: "App" },
  { keys: ["/"], label: "Jump to the chat box", group: "App" },
  { keys: ["esc"], label: "Stop the assistant", group: "App" },
  { keys: ["enter"], label: "Send (queues it while the assistant works)", group: "Chat box" },
  { keys: ["shift", "enter"], label: "New line", group: "Chat box" },
  { keys: ["/"], label: "Commands (at the start of the box)", group: "Chat box" },
  { keys: ["#"], label: "Start with # to remember a fact", group: "Chat box" },
  { keys: ["↑ ↓"], label: "Previous / next prompt", group: "Chat box" },
  { keys: ["?"], label: "Shortcuts (in an empty box)", group: "Chat box" },
  { keys: ["mod", "enter"], label: "Send the email (or save the draft)", group: "Email approval" },
  { keys: ["esc"], label: "Don't send", group: "Email approval" },
];

const MAC_KEYS: Record<string, string> = {
  mod: "⌘",
  alt: "⌥",
  shift: "⇧",
  enter: "↵",
  esc: "esc",
};

const PC_KEYS: Record<string, string> = {
  mod: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  enter: "Enter",
  esc: "Esc",
};

/** ["mod", "K"] -> "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export function formatKeys(keys: string[], mac: boolean): string {
  const names = keys.map((key) => (mac ? MAC_KEYS : PC_KEYS)[key] ?? key);
  return mac ? names.join("") : names.join("+");
}
