"use client";

import { Kbd } from "@/components/kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SLASH_COMMANDS } from "@/lib/commands";
import { SHORTCUTS } from "@/lib/shortcuts";
import { KeyboardIcon } from "lucide-react";

/** Every shortcut and slash command (⌘/, /help, or ? in an empty box). */
export function ShortcutsDialog({
  open,
  onOpenChange,
  mac,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mac: boolean;
}) {
  const groups = [...new Set(SHORTCUTS.map((shortcut) => shortcut.group))];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyboardIcon className="size-4" /> Shortcuts and commands
          </DialogTitle>
          <DialogDescription>
            Everything works from the keyboard. Type / in the chat box for commands.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-4">
            {groups.map((group) => (
              <section key={group}>
                <h3 className="text-muted-foreground mb-1.5 font-mono text-[11px] tracking-wide uppercase">
                  {group}
                </h3>
                <ul className="space-y-1">
                  {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
                    <li
                      className="flex items-center justify-between gap-3 text-sm"
                      key={`${group}-${shortcut.label}`}
                    >
                      <span>{shortcut.label}</span>
                      <Kbd keys={shortcut.keys} mac={mac} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <section>
            <h3 className="text-muted-foreground mb-1.5 font-mono text-[11px] tracking-wide uppercase">
              Slash commands
            </h3>
            <ul className="space-y-1.5">
              {SLASH_COMMANDS.map((command) => (
                <li className="text-sm" key={command.name}>
                  <span className="font-mono text-xs">
                    /{command.name}
                    {command.args ? (
                      <span className="text-muted-foreground"> {command.args}</span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground"> — {command.description}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
