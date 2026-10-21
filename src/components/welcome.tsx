"use client";

import { formatKeys } from "@/lib/shortcuts";
import { ArrowRightIcon } from "lucide-react";

const TIPS = [
  ["Find roles", "“remote backend engineer jobs posted this week” or /jobs"],
  ["Find who's hiring", "click Find recruiter on a job, then Get email"],
  ["Reach out", "Write email → review it → Send, from your own Gmail"],
  ["Teach it about you", "# I have 6 years of Go experience — remembered in every chat"],
];

/** Empty-chat screen in the spirit of Claude Code's welcome box. */
export function Welcome({
  mac,
  model,
  mailbox,
  trackerOn,
  memoryCount,
  configured,
  suggestions,
  onSuggestion,
  onOpenSettings,
}: {
  mac: boolean;
  model: string;
  mailbox: string | null;
  trackerOn: boolean;
  memoryCount: number;
  configured: boolean;
  suggestions: string[];
  onSuggestion: (text: string) => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-1 pt-8 pb-4">
      <div className="rounded-xl border px-5 py-4 font-mono">
        <p className="text-sm">
          <span className="text-[#d97757]">✻</span> Welcome to <span className="font-semibold">Outreach</span>
          <span className="text-muted-foreground"> — your job-search agent</span>
        </p>
        <p className="text-muted-foreground mt-3 text-xs">
          /help for commands · {formatKeys(["mod", "K"], mac)} palette ·{" "}
          {formatKeys(["mod", "0"], mac)} new chat · # remember a fact
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          model {model || "—"} · mail {mailbox ?? "not connected"} · tracker{" "}
          {trackerOn ? "on" : "off"} · {memoryCount} memor{memoryCount === 1 ? "y" : "ies"}
        </p>
      </div>

      {!configured ? (
        <button
          className="hover:bg-accent/50 mt-4 flex w-full items-center justify-between rounded-lg border border-dashed px-4 py-3 text-left text-sm"
          onClick={onOpenSettings}
          type="button"
        >
          Add your API keys to get started
          <ArrowRightIcon className="size-4" />
        </button>
      ) : null}

      <p className="text-muted-foreground mt-6 mb-2 font-mono text-xs">Tips for getting started:</p>
      <ol className="space-y-1.5 text-sm">
        {TIPS.map(([title, detail], index) => (
          <li className="flex gap-2" key={title}>
            <span className="text-muted-foreground font-mono text-xs leading-5">{index + 1}.</span>
            <span>
              <span className="font-medium">{title}</span>
              <span className="text-muted-foreground"> — {detail}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-6 flex flex-col gap-2">
        {suggestions.map((suggestion) => (
          <button
            className="hover:bg-accent/50 rounded-lg border px-4 py-2.5 text-left text-sm"
            disabled={!configured}
            key={suggestion}
            onClick={() => onSuggestion(suggestion)}
            type="button"
          >
            <span className="text-muted-foreground mr-2 font-mono">›</span>
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
