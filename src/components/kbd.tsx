import { formatKeys } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/** A key or key combination, e.g. ⌘K / Ctrl+K. */
export function Kbd({
  keys,
  mac,
  className,
}: {
  keys: string[];
  mac: boolean;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "bg-muted text-muted-foreground inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 font-mono text-[10px] font-medium",
        className,
      )}
    >
      {formatKeys(keys, mac)}
    </kbd>
  );
}
