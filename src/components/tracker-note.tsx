"use client";

import type { TrackerFields } from "@/lib/tool-outputs";
import { FileSpreadsheetIcon } from "lucide-react";

/** One line under a result: whether it reached the Google Sheet tracker. */
export function TrackerNote({ fields }: { fields: TrackerFields }) {
  if (!fields.tracker) return null;

  if (fields.tracker === "failed") {
    return (
      <p className="flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-500">
        <FileSpreadsheetIcon className="mt-px size-3 shrink-0" />
        <span>
          Not logged to your tracker{fields.tracker_error ? `: ${fields.tracker_error}` : "."} It
          will retry on the next sync.
        </span>
      </p>
    );
  }

  const logged = fields.tracker === "logged";
  const label = logged ? "Logged to your tracker" : "Logging to your tracker…";
  return (
    <p className="text-muted-foreground flex items-center gap-1 text-[11px]">
      <FileSpreadsheetIcon className={`size-3 shrink-0 ${logged ? "text-green-600" : ""}`} />
      {fields.tracker_url ? (
        <a
          className="hover:text-foreground hover:underline"
          href={fields.tracker_url}
          rel="noopener noreferrer"
          target="_blank"
        >
          {label}
        </a>
      ) : (
        label
      )}
    </p>
  );
}
