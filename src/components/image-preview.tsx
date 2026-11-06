"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useState } from "react";

/**
 * An attached image shown small, opening large on click (Esc, the X button
 * or a click anywhere closes it, like any dialog).
 */
export function ImagePreview({
  src,
  name,
  thumbnailClass,
  className,
}: {
  src: string;
  name: string;
  /** Size/shape of the small (always visible) image. */
  thumbnailClass?: string;
  /** Extra classes for the trigger button. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-label={`Preview ${name}`}
        className={cn("cursor-zoom-in", className)}
        onClick={() => setOpen(true)}
        type="button"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- local blob/data URL */}
        <img alt={name} className={cn("block", thumbnailClass)} src={src} />
      </button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent
          className="w-fit max-w-[92vw] p-2 sm:max-w-[92vw]"
          onClick={() => setOpen(false)}
        >
          <DialogTitle className="sr-only">{name}</DialogTitle>
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob/data URL */}
          <img
            alt={name}
            className="max-h-[80vh] w-auto rounded-md object-contain"
            src={src}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}