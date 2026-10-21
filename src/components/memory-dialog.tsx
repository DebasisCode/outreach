"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { MemoryItem } from "@/lib/tool-outputs";
import { BrainIcon, CheckIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";

const MAX_ITEMS = 60;

function MemoryRow({
  memory,
  onUpdate,
  onDelete,
}: {
  memory: MemoryItem;
  onUpdate: (id: string, content: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);

  if (editing) {
    const save = async () => {
      if (!draft.trim() || draft.trim() === memory.content) {
        setEditing(false);
        return;
      }
      if (await onUpdate(memory.id, draft)) setEditing(false);
    };
    return (
      <li className="flex items-center gap-1.5 py-1.5">
        <Input
          autoFocus
          className="h-8 text-sm"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") {
              event.stopPropagation();
              setDraft(memory.content);
              setEditing(false);
            }
          }}
          value={draft}
        />
        <Button aria-label="Save" onClick={() => void save()} size="icon-sm" variant="ghost">
          <CheckIcon />
        </Button>
        <Button
          aria-label="Cancel"
          onClick={() => {
            setDraft(memory.content);
            setEditing(false);
          }}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-2 py-2">
      <span className="text-muted-foreground mt-0.5 font-mono text-xs">-</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words">{memory.content}</p>
        <p className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-[11px]">
          <Badge className="rounded-full px-1.5 py-0 text-[10px]" variant="outline">
            {memory.source === "assistant" ? "saved by assistant" : "you"}
          </Badge>
          {new Date(memory.updatedAt).toLocaleDateString()}
        </p>
      </div>
      <div className="flex shrink-0 opacity-60 transition-opacity group-hover:opacity-100">
        <Button
          aria-label="Edit"
          onClick={() => {
            setDraft(memory.content);
            setEditing(true);
          }}
          size="icon-sm"
          variant="ghost"
        >
          <PencilIcon />
        </Button>
        <Button
          aria-label="Forget"
          onClick={() => void onDelete(memory.id)}
          size="icon-sm"
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
      </div>
    </li>
  );
}

/**
 * What the assistant always knows about the user — the job-search
 * equivalent of a CLAUDE.md file. Added with # in the chat box, here, or by
 * the assistant itself.
 */
export function MemoryDialog({
  open,
  onOpenChange,
  memories,
  onAdd,
  onUpdate,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memories: MemoryItem[];
  onAdd: (content: string) => Promise<boolean>;
  onUpdate: (id: string, content: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const tokens = Math.ceil(memories.reduce((sum, memory) => sum + memory.content.length + 12, 0) / 4);

  const add = async () => {
    if (!draft.trim()) return;
    if (await onAdd(draft)) setDraft("");
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BrainIcon className="size-4" /> Memory
          </DialogTitle>
          <DialogDescription>
            Facts the assistant knows in every chat — your background, target roles, how you like
            emails written. Start a message with <span className="font-mono">#</span> to add one, or
            tell the assistant and it saves them itself.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Input
            onChange={(event) => setDraft(event.target.value)}
            placeholder="e.g. 6 years of backend experience in Go and Python"
            value={draft}
          />
          <Button disabled={!draft.trim()} size="sm" type="submit">
            <PlusIcon /> Add
          </Button>
        </form>

        {memories.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            Nothing yet. Try <span className="font-mono"># I sign emails as Debasis</span> in the
            chat box.
          </p>
        ) : (
          <ul className="divide-y">
            {memories.map((memory) => (
              <MemoryRow
                key={`${memory.id}-${memory.updatedAt}`}
                memory={memory}
                onDelete={onDelete}
                onUpdate={onUpdate}
              />
            ))}
          </ul>
        )}

        <p className="text-muted-foreground border-t pt-2 font-mono text-[11px]">
          {memories.length}/{MAX_ITEMS} items · ~{tokens} tokens in every request
        </p>
      </DialogContent>
    </Dialog>
  );
}
