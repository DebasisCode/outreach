"use client";

import { Kbd } from "@/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ContextInfo } from "@/lib/tool-outputs";
import { BrainIcon, ChevronDownIcon, LoaderCircleIcon } from "lucide-react";

const compactNumber = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);

/** A small ring that fills up with the context. */
function Ring({ percent }: { percent: number }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg aria-hidden className="size-3 -rotate-90" viewBox="0 0 12 12">
      <circle className="stroke-border" cx="6" cy="6" fill="none" r={radius} strokeWidth="2" />
      <circle
        className="stroke-current"
        cx="6"
        cy="6"
        fill="none"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(percent, 100) / 100)}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

/**
 * The line under the chat box: what keys do right now on the left; context,
 * memory and model on the right.
 */
export function StatusLine({
  mac,
  busy,
  approval,
  queued,
  context,
  compacting,
  memoryCount,
  model,
  onShortcuts,
  onMemory,
  onModel,
  onCompact,
}: {
  mac: boolean;
  busy: boolean;
  approval: "send" | "draft" | null;
  queued: number;
  context: ContextInfo | null;
  compacting: boolean;
  memoryCount: number;
  model: string;
  onShortcuts: () => void;
  onMemory: () => void;
  onModel: () => void;
  onCompact: () => void;
}) {
  const percent = context ? Math.round((context.tokens / context.limit) * 100) : null;

  let hints;
  if (approval) {
    hints = (
      <span className="flex items-center gap-1.5">
        <Kbd keys={["mod", "enter"]} mac={mac} /> {approval === "send" ? "send email" : "save draft"}
        <span className="opacity-50">·</span>
        <Kbd keys={["esc"]} mac={mac} /> {approval === "send" ? "don't send" : "don't save"}
      </span>
    );
  } else if (busy) {
    hints = (
      <span className="flex items-center gap-1.5">
        <Kbd keys={["esc"]} mac={mac} /> to interrupt
        {queued ? <span>· {queued} queued</span> : <span className="opacity-70">· type to queue a message</span>}
      </span>
    );
  } else {
    hints = (
      <span className="flex items-center gap-2">
        <button className="hover:text-foreground" onClick={onShortcuts} type="button">
          ? for shortcuts
        </button>
        <span className="hidden opacity-70 sm:inline">· / commands · # remember</span>
      </span>
    );
  }

  return (
    <div className="text-muted-foreground flex items-center justify-between gap-3 px-1 pt-1.5 font-mono text-[11px]">
      <div className="min-w-0 truncate">{hints}</div>
      <div className="flex shrink-0 items-center gap-3">
        {compacting ? (
          <span className="flex items-center gap-1">
            <LoaderCircleIcon className="size-3 animate-spin" /> compacting…
          </span>
        ) : percent !== null && context ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={`hover:text-foreground flex items-center gap-1 ${
                  percent >= 75 ? "text-amber-600 dark:text-amber-500" : ""
                }`}
                onClick={onCompact}
                type="button"
              >
                <Ring percent={percent} />
                {percent}% context
              </button>
            </TooltipTrigger>
            <TooltipContent>
              ~{compactNumber(context.tokens)} of {compactNumber(context.limit)} tokens. Older
              turns are summarized automatically at 100% — click to /compact now.
            </TooltipContent>
          </Tooltip>
        ) : null}
        <button
          className="hover:text-foreground flex items-center gap-1"
          onClick={onMemory}
          title="What the assistant remembers about you"
          type="button"
        >
          <BrainIcon className="size-3" />
          {memoryCount}
        </button>
        <button
          className="hover:text-foreground flex max-w-48 items-center gap-0.5 truncate"
          onClick={onModel}
          title="Switch model"
          type="button"
        >
          <span className="truncate">{model || "no model"}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      </div>
    </div>
  );
}
