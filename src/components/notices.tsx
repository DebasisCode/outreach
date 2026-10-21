"use client";

import { Button } from "@/components/ui/button";
import { AnimatePresence, motion } from "motion/react";
import { CircleAlertIcon, InfoIcon, XIcon } from "lucide-react";

export interface Notice {
  id: number;
  text: string;
  tone?: "info" | "error";
  action?: { label: string; run: () => void };
}

/** Short-lived messages above the chat box ("Saved to memory · Undo"). */
export function Notices({
  notices,
  onDismiss,
}: {
  notices: Notice[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-full z-30 mb-2 flex flex-col items-center gap-1.5 px-4"
    >
      <AnimatePresence initial={false}>
        {notices.map((notice) => (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="bg-popover text-popover-foreground pointer-events-auto flex max-w-full items-center gap-2 rounded-lg border py-1.5 pr-1.5 pl-3 text-xs shadow-md"
            exit={{ opacity: 0, y: 6 }}
            initial={{ opacity: 0, y: 6 }}
            key={notice.id}
            layout
            transition={{ duration: 0.15 }}
          >
            {notice.tone === "error" ? (
              <CircleAlertIcon className="text-destructive size-3.5 shrink-0" />
            ) : (
              <InfoIcon className="text-muted-foreground size-3.5 shrink-0" />
            )}
            <span className="min-w-0 truncate">{notice.text}</span>
            {notice.action ? (
              <Button
                className="h-6 px-2 text-xs"
                onClick={() => {
                  notice.action?.run();
                  onDismiss(notice.id);
                }}
                size="xs"
                variant="outline"
              >
                {notice.action.label}
              </Button>
            ) : null}
            <button
              aria-label="Dismiss"
              className="text-muted-foreground hover:text-foreground rounded p-0.5"
              onClick={() => onDismiss(notice.id)}
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
