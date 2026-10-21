"use client";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { formatKeys } from "@/lib/shortcuts";
import { LoaderCircleIcon, MessageSquareIcon, SparklesIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * Ranks text matches first ("theme" → "Light theme"), then all-words matches,
 * then letters in order — so the top item is the one you meant.
 */
function rank(value: string, search: string, keywords?: string[]): number {
  const text = value.toLowerCase();
  const query = search.toLowerCase().trim();
  if (!query) return 1;
  const at = text.indexOf(query);
  if (at >= 0) return 1 - at / (text.length * 2);
  const words = query.split(/\s+/);
  const extra = (keywords ?? []).join(" ").toLowerCase();
  if (words.every((word) => text.includes(word) || extra.includes(word))) return 0.4;
  let next = 0;
  for (const char of text) if (char === query[next]) next += 1;
  return next === query.length ? 0.1 : 0;
}

export interface PaletteAction {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  /** Shortcut shown on the right, e.g. ["mod", "0"]. */
  keys?: string[];
  keywords?: string[];
  run: () => void;
  /** Keep the palette open afterwards (e.g. to pick a model next). */
  keepOpen?: boolean;
}

/**
 * ⌘K / Ctrl+K: every action and recent chat in one searchable list, plus a
 * model picker ("Switch model…"; Backspace goes back).
 */
export function CommandPalette({
  open,
  onOpenChange,
  mac,
  actions,
  chats,
  onOpenChat,
  mode,
  onModeChange,
  models,
  modelGroupLabel,
  currentModel,
  onPickModel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mac: boolean;
  actions: PaletteAction[];
  chats: Array<{ id: string; title: string }>;
  onOpenChat: (id: string) => void;
  mode: "root" | "models";
  onModeChange: (mode: "root" | "models") => void;
  /** null while loading. */
  models: string[] | null;
  modelGroupLabel: string;
  currentModel: string;
  onPickModel: (model: string) => void;
}) {
  const [search, setSearch] = useState("");
  const groups = [...new Set(actions.map((action) => action.group))];

  const close = () => {
    setSearch("");
    onOpenChange(false);
  };

  return (
    <CommandDialog
      description="Run an action or open a chat"
      onOpenChange={(next) => {
        if (!next) setSearch("");
        onOpenChange(next);
      }}
      open={open}
      title="Command palette"
    >
      <Command
        filter={rank}
        loop
        onKeyDown={(event) => {
          if (mode === "models" && event.key === "Backspace" && search === "") {
            event.preventDefault();
            onModeChange("root");
          }
        }}
      >
        <CommandInput
          onValueChange={setSearch}
          placeholder={
            mode === "models" ? "Pick a model… (backspace to go back)" : "Type a command or search chats…"
          }
          value={search}
        />
        <CommandList className="max-h-[min(24rem,55vh)]">
          <CommandEmpty>No matches.</CommandEmpty>
          {mode === "models" ? (
            models === null ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                <LoaderCircleIcon className="size-4 animate-spin" /> Loading models…
              </div>
            ) : (
              <CommandGroup heading={modelGroupLabel}>
                {models.map((model) => (
                  <CommandItem
                    data-checked={model === currentModel}
                    key={model}
                    onSelect={() => {
                      onPickModel(model);
                      close();
                    }}
                    value={model}
                  >
                    <SparklesIcon />
                    <span className="font-mono text-xs">{model}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )
          ) : (
            <>
              {groups.map((group) => (
                <CommandGroup heading={group} key={group}>
                  {actions
                    .filter((action) => action.group === group)
                    .map((action) => (
                      <CommandItem
                        key={action.id}
                        keywords={action.keywords}
                        onSelect={() => {
                          if (action.keepOpen) setSearch("");
                          else close();
                          action.run();
                        }}
                        value={`${action.group} ${action.label}`}
                      >
                        {action.icon}
                        <span>{action.label}</span>
                        {action.keys ? (
                          <CommandShortcut>{formatKeys(action.keys, mac)}</CommandShortcut>
                        ) : null}
                      </CommandItem>
                    ))}
                </CommandGroup>
              ))}
              {chats.length ? (
                <CommandGroup heading="Chats">
                  {chats.slice(0, 40).map((chat, index) => (
                    <CommandItem
                      key={chat.id}
                      onSelect={() => {
                        close();
                        onOpenChat(chat.id);
                      }}
                      value={`chat ${chat.title} #${index}`}
                    >
                      <MessageSquareIcon />
                      <span className="truncate">{chat.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
