"use client";

import { cn } from "@/lib/utils";
import { motion } from "motion/react";

const DOTS = [0, 1, 2];

export type ThinkingIndicatorProps = {
  className?: string;
  label?: string;
};

export const ThinkingIndicator = ({
  className,
  label = "Thinking",
}: ThinkingIndicatorProps) => (
  <motion.div
    animate={{ opacity: 1, y: 0 }}
    aria-live="polite"
    className={cn("flex items-center gap-2.5", className)}
    initial={{ opacity: 0, y: 4 }}
    role="status"
    transition={{ duration: 0.2, ease: "easeOut" }}
  >
    <div className="flex h-4 items-end gap-1">
      {DOTS.map((i) => (
        <motion.span
          animate={{
            opacity: [0.35, 1, 0.35],
            scale: [1, 1.2, 1],
            y: [0, -5, 0],
          }}
          className="bg-muted-foreground size-1.5 rounded-full"
          key={i}
          transition={{
            delay: i * 0.18,
            duration: 1,
            ease: "easeInOut",
            repeat: Infinity,
          }}
        />
      ))}
    </div>
    <span className="thinking-shimmer text-muted-foreground text-sm font-medium">
      {label}…
    </span>
  </motion.div>
);