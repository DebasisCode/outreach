"use client";

import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { ImagePreview } from "@/components/image-preview";
import { matchCommands, requiresArgs, type SlashCommand } from "@/lib/commands";
import type { ChatStatus, FileUIPart } from "ai";
import {
  ClockIcon,
  FileTextIcon,
  PaperclipIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

/** What the chat box takes: images go to the model; documents (PDF, DOCX, TXT…) are read into the knowledge base. */
export const CHAT_ACCEPT =
  "image/*,.pdf,.docx,.txt,.md,.markdown,.csv,.json,application/pdf,text/plain,text/markdown,text/csv,application/json";
const CHAT_MAX_FILES = 6;
const CHAT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Chips for the attached files, above the textarea. Images show a thumbnail.
 * Lives inside <PromptInput> so it can use its attachments context.
 */
function AttachmentChips({ onCount }: { onCount: (count: number) => void }) {
  const attachments = usePromptInputAttachments();
  useEffect(() => onCount(attachments.files.length), [attachments.files.length, onCount]);
  if (attachments.files.length === 0) return null;
  return (
    // w-full: the group is a centered column, chips hug left without it.
    <div className="flex w-full flex-wrap items-center gap-1.5 px-2 pt-2">
      {attachments.files.map((file) => {
        const image = file.mediaType?.startsWith("image/");
        return (
          <span
            className="bg-muted/70 border-border/60 flex max-w-48 items-center gap-1.5 rounded-md border py-1 pr-1 pl-1.5 text-xs"
            key={file.id}
          >
            {image ? (
              <ImagePreview
                className="shrink-0"
                name={file.filename ?? "image"}
                src={file.url}
                thumbnailClass="size-6 rounded object-cover"
              />
            ) : (
              <FileTextIcon className="text-muted-foreground size-3.5 shrink-0" />
            )}
            <span className="min-w-0 truncate">{file.filename ?? "file"}</span>
            <button
              aria-label={`Remove ${file.filename ?? "attachment"}`}
              className="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5"
              onClick={() => attachments.remove(file.id)}
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        );
      })}
      <p className="text-muted-foreground w-full px-1 pb-0.5 text-[10px]">
        Images are sent with the message · documents are saved to your knowledge base
      </p>
    </div>
  );
}

/** Paperclip button for the composer's tools row; opens the file picker. */
function AttachButton() {
  const attachments = usePromptInputAttachments();
  return (
    <button
      aria-label="Attach files"
      className="hover:bg-accent hover:text-foreground text-muted-foreground inline-flex size-7 items-center justify-center rounded-md transition-colors"
      onClick={() => attachments.openFileDialog()}
      title="Attach files — or drop / paste them into the box"
      type="button"
    >
      <PaperclipIcon className="size-4" />
    </button>
  );
}

/**
 * The chat box, terminal-agent style: "/" opens the command list, ↑/↓ walk
 * through earlier prompts, Esc interrupts, and messages typed while the
 * assistant works wait in a queue. Files attach by drag & drop, Ctrl+V
 * (screenshots) or the paperclip: images go along with the message,
 * documents land in the knowledge base.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  onEscape,
  onShowShortcuts,
  onFileError,
  status,
  history,
  queued,
  onUnqueue,
  placeholder,
  textareaRef,
  footer,
}: {
  value: string;
  onChange: (value: string) => void;
  /** A message, a /command or a # memory — the page decides what to do. */
  onSubmit: (text: string, files: FileUIPart[]) => void;
  onStop: () => void;
  /** Esc when no menu is open: interrupt, or decline a waiting email. */
  onEscape: () => void;
  onShowShortcuts: () => void;
  /** Bad attachment (too big, unsupported type) — surfaced as a notice. */
  onFileError?: (message: string) => void;
  status: ChatStatus;
  /** Earlier prompts, oldest first. */
  history: string[];
  queued: string[];
  onUnqueue: (index: number) => void;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Buttons on the left of the box's footer. */
  footer?: ReactNode;
}) {
  const busy = status === "submitted" || status === "streaming";
  const [highlight, setHighlight] = useState(0);
  // The value at which the user closed the command list with Esc.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  // Position while walking through history with ↑/↓ (null = editing a draft).
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [attachmentCount, setAttachmentCount] = useState(0);
  // Files being dragged over the box (visual cue only; PromptInput adds them).
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const draftRef = useRef("");

  const commandQuery = value.startsWith("/") && !/\s/.test(value) ? value.slice(1) : null;
  const commands = commandQuery === null ? [] : matchCommands(commandQuery);
  const menuOpen = commands.length > 0 && dismissedAt !== value;
  const active = Math.min(highlight, Math.max(commands.length - 1, 0));

  const edit = (next: string) => {
    setHighlight(0);
    setHistoryIndex(null);
    onChange(next);
  };

  const submit = (text: string, files: FileUIPart[] = []) => {
    if (!text.trim() && files.length === 0) return;
    setHistoryIndex(null);
    onSubmit(text, files);
  };

  // Enter runs a command; one that needs arguments is completed instead.
  const choose = (command: SlashCommand, complete = false) => {
    if (complete || requiresArgs(command)) {
      edit(`/${command.name} `);
      textareaRef.current?.focus();
      return;
    }
    submit(`/${command.name}`);
  };

  const recall = (index: number | null) => {
    setHistoryIndex(index);
    onChange(index === null ? draftRef.current : history[index]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const box = event.currentTarget;

    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((active + step + commands.length) % commands.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        choose(commands[active], event.key === "Tab");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAt(value);
        return;
      }
    }

    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key === "?" && value === "") {
      event.preventDefault();
      onShowShortcuts();
      return;
    }
    // Like a terminal: ↑ on the first line walks back through earlier prompts
    // (while browsing, in an empty box, or with the cursor at the very start).
    const onFirstLine = !box.value.slice(0, box.selectionStart).includes("\n");
    const onLastLine = !box.value.slice(box.selectionEnd).includes("\n");
    const atStart = box.selectionStart === 0 && box.selectionEnd === 0;
    if (
      event.key === "ArrowUp" &&
      !event.shiftKey &&
      history.length > 0 &&
      onFirstLine &&
      (historyIndex !== null || value === "" || atStart)
    ) {
      event.preventDefault();
      if (historyIndex === null) draftRef.current = value;
      recall(historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1));
      return;
    }
    if (event.key === "ArrowDown" && !event.shiftKey && historyIndex !== null && onLastLine) {
      event.preventDefault();
      recall(historyIndex + 1 < history.length ? historyIndex + 1 : null);
    }
  };

  const onDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const endDrag = () => {
    dragDepth.current = 0;
    setDragging(false);
  };

  return (
    <div
      className="relative"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(event) => {
        if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
      }}
      onDrop={endDrag}
    >
      {menuOpen ? (
        <div
          className="bg-popover text-popover-foreground absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-lg border p-1 shadow-lg"
          role="listbox"
        >
          {commands.map((command, index) => (
            <button
              aria-selected={index === active}
              className={`flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left ${
                index === active ? "bg-accent text-accent-foreground" : ""
              }`}
              key={command.name}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(command);
              }}
              onMouseEnter={() => setHighlight(index)}
              role="option"
              type="button"
            >
              <span className="shrink-0 font-mono text-xs">
                /{command.name}
                {command.args ? (
                  <span className="text-muted-foreground"> {command.args}</span>
                ) : null}
              </span>
              <span className="text-muted-foreground min-w-0 truncate text-xs">
                {command.description}
              </span>
            </button>
          ))}
          <p className="text-muted-foreground border-t px-2 pt-1.5 pb-0.5 font-mono text-[10px]">
            ↑↓ select · enter run · tab complete · esc close
          </p>
        </div>
      ) : null}

      {queued.length ? (
        <div className="mb-2 flex flex-col gap-1">
          {queued.map((text, index) => (
            <div
              className="bg-muted/60 flex items-center gap-2 rounded-md px-2.5 py-1 text-xs"
              key={`${index}-${text}`}
            >
              <ClockIcon className="text-muted-foreground size-3 shrink-0" />
              <span className="min-w-0 truncate">{text}</span>
              <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[10px]">
                queued
              </span>
              <button
                aria-label="Remove from queue"
                className="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5"
                onClick={() => onUnqueue(index)}
                type="button"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <PromptInput
        accept={CHAT_ACCEPT}
        className="border-border/60"
        maxFileSize={CHAT_MAX_FILE_BYTES}
        maxFiles={CHAT_MAX_FILES}
        multiple
        onError={(err) => onFileError?.(err.message)}
        onSubmit={({ text, files }) => submit(text, files)}
      >
        <AttachmentChips onCount={setAttachmentCount} />
        <PromptInputTextarea
          autoFocus
          onChange={(event) => edit(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          ref={textareaRef}
          value={value}
        />
        <PromptInputFooter>
          <PromptInputTools>
            <AttachButton />
            {footer}
          </PromptInputTools>
          <PromptInputSubmit
            disabled={!value.trim() && attachmentCount === 0 && !busy}
            onStop={onStop}
            status={status}
          />
        </PromptInputFooter>
      </PromptInput>

      {dragging ? (
        <div className="border-primary bg-background/80 pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed">
          <p className="text-muted-foreground text-xs font-medium">
            Drop files to attach — images, PDF, DOCX, text
          </p>
        </div>
      ) : null}
    </div>
  );
}
