"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  BrainIcon,
  CheckCircle2Icon,
  FileUpIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";
import { ACCEPTED_UPLOAD_TYPES } from "@/lib/extract";
import type { UserKeys } from "@/lib/types";

export interface KnowledgeItem {
  id: string;
  title: string | null;
  preview: string;
  createdAt: number;
}

interface KnowledgeDialogProps {
  keys: UserKeys | null;
  items: KnowledgeItem[];
  onOpenChange: (open: boolean) => void;
  onStored: () => void;
  open: boolean;
}

export function KnowledgeDialog({
  keys,
  items,
  onOpenChange,
  onStored,
  open,
}: KnowledgeDialogProps) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const store = async () => {
    if (!keys || !text.trim()) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys, title: title.trim() || null, text }),
      });
      const data = (await res.json()) as {
        stored?: number;
        embedded?: boolean;
        total?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to store");
      setMessage(storedMessage(data.stored ?? 0, data.embedded, data.total ?? 0));
      setText("");
      setTitle("");
      onStored();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to store");
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File) => {
    if (!keys) return;
    setUploading(true);
    setMessage(null);
    setFileName(file.name);
    try {
      const form = new FormData();
      form.append("keys", JSON.stringify(keys));
      form.append("file", file);
      const res = await fetch("/api/knowledge/upload", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as {
        stored?: number;
        embedded?: boolean;
        total?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setMessage(storedMessage(data.stored ?? 0, data.embedded, data.total ?? 0));
      onStored();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      setFileName(null);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/knowledge?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    onStored();
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BrainIcon className="size-4" /> Knowledge base
          </DialogTitle>
          <DialogDescription>
            Upload or paste your resume, job descriptions, and application
            notes. The assistant retrieves the right context before drafting
            every email (RAG: embeddings on Google/OpenAI, keyword search
            otherwise).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          {/* Upload dropzone */}
          <button
            className="border-border hover:border-ring hover:bg-accent/30 flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center transition-colors disabled:opacity-50"
            disabled={!keys || uploading}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            {uploading ? (
              <LoaderCircleIcon className="text-muted-foreground size-5 animate-spin" />
            ) : (
              <FileUpIcon className="text-muted-foreground size-5" />
            )}
            <span className="text-sm font-medium">
              {uploading
                ? `Reading ${fileName ?? "file"}...`
                : "Upload resume (PDF, DOCX, TXT, MD)"}
            </span>
            <span className="text-muted-foreground text-xs">
              or click to browse — max 10MB
            </span>
          </button>
          <input
            aria-hidden
            className="hidden"
            accept={ACCEPTED_UPLOAD_TYPES}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = "";
            }}
            ref={fileInputRef}
            type="file"
          />

          <div className="flex items-center gap-2">
            <span className="bg-border h-px flex-1" />
            <span className="text-muted-foreground text-[10px] tracking-widest uppercase">
              or paste
            </span>
            <span className="bg-border h-px flex-1" />
          </div>

          <Label className="text-xs">Title (optional)</Label>
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Resume — SDE 2027"
            value={title}
          />
          <Label className="text-xs">Content</Label>
          <Textarea
            onChange={(event) => setText(event.target.value)}
            placeholder="Paste resume text, a job description, application status notes..."
            rows={7}
            value={text}
          />
          <Button
            disabled={!text.trim() || saving || !keys}
            onClick={() => void store()}
            size="sm"
          >
            {saving ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <PlusIcon />
            )}
            Store in knowledge base
          </Button>
          {message ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <CheckCircle2Icon className="size-3" /> {message}
            </p>
          ) : null}

          {items.length > 0 ? (
            <div className="mt-2 grid gap-2">
              <Label className="text-xs">Stored ({items.length})</Label>
              {items.map((item) => (
                <div
                  className="border-border/60 flex items-start justify-between gap-2 rounded-md border px-3 py-2"
                  key={item.id}
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                      {item.title ? (
                        <PaperclipIcon className="text-muted-foreground size-3" />
                      ) : null}
                      {item.title ?? "(untitled)"}
                    </p>
                    <p className="text-muted-foreground truncate text-[11px]">
                      {item.preview}
                    </p>
                  </div>
                  <Button
                    aria-label="Delete"
                    onClick={() => void remove(item.id)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2Icon className="text-muted-foreground size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">Nothing stored yet.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function storedMessage(
  stored: number,
  embedded: boolean | undefined,
  total: number,
): string {
  return `Stored ${stored} chunk${stored === 1 ? "" : "s"}${
    embedded ? " (embedded)" : " (keyword index)"
  } — ${total} total`;
}