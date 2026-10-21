"use client";

import { Kbd } from "@/components/kbd";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  BrainIcon,
  BookOpenIcon,
  EllipsisIcon,
  MailSearchIcon,
  PencilIcon,
  SquarePenIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
}

function ChatRow({
  active,
  chat,
  onDelete,
  onOpen,
  onRename,
}: {
  active: boolean;
  chat: ChatSummary;
  onDelete: () => void;
  onOpen: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title);

  const finish = (save: boolean) => {
    const next = draft.trim();
    setEditing(false);
    if (save && next && next !== chat.title) onRename(next);
  };

  if (editing) {
    return (
      <input
        autoFocus
        className="border-ring bg-background w-full rounded-md border px-2 py-1.5 text-xs outline-none"
        onBlur={() => finish(true)}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") finish(false);
        }}
        value={draft}
      />
    );
  }

  return (
    <DropdownMenu>
      <div
        className={`group flex min-w-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs ${
          active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
        }`}
      >
        <button className="min-w-0 flex-1 truncate text-left" onClick={onOpen} type="button">
          {chat.title}
        </button>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Chat options"
            className="text-muted-foreground hover:text-foreground -m-0.5 shrink-0 rounded-sm p-1 opacity-60 transition-opacity group-hover:opacity-100 hover:opacity-100 data-[state=open]:opacity-100"
            type="button"
          >
            <EllipsisIcon className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="start" side="bottom">
        <DropdownMenuItem
          onSelect={() => {
            setDraft(chat.title);
            setEditing(true);
          }}
        >
          <PencilIcon className="size-3" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
          <Trash2Icon className="size-3" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Chats on the left, like the session list in Claude Code or Codex. */
export function ChatSidebar({
  className,
  mac,
  chats,
  activeChatId,
  memoryCount,
  onNewChat,
  onOpenChat,
  onRenameChat,
  onDeleteChat,
  onKnowledge,
  onContacts,
  onMemory,
}: {
  className?: string;
  mac: boolean;
  chats: ChatSummary[];
  activeChatId: string | null;
  memoryCount: number;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onDeleteChat: (id: string) => void;
  onKnowledge: () => void;
  onContacts: () => void;
  onMemory: () => void;
}) {
  return (
    <aside
      className={cn(
        "border-border/60 bg-sidebar md:bg-sidebar/40 flex w-64 shrink-0 flex-col border-r",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-4 py-4">
        <MailSearchIcon className="size-5" />
        <span className="font-heading text-sm font-bold tracking-tight">Outreach</span>
      </div>
      <div className="px-3">
        <Button className="w-full justify-between" onClick={onNewChat} size="sm" variant="outline">
          <span className="flex items-center gap-2">
            <SquarePenIcon className="size-4" /> New chat
          </span>
          <Kbd className="h-4.5" keys={["mod", "0"]} mac={mac} />
        </Button>
      </div>
      <ScrollArea className="mt-4 min-h-0 flex-1 px-2">
        <p className="text-muted-foreground mb-1 px-2 text-[10px] font-semibold tracking-widest uppercase">
          History
        </p>
        {chats.length === 0 ? (
          <p className="text-muted-foreground px-2 py-2 text-xs">No chats yet.</p>
        ) : (
          chats.map((chat) => (
            <ChatRow
              active={chat.id === activeChatId}
              chat={chat}
              key={chat.id}
              onDelete={() => onDeleteChat(chat.id)}
              onOpen={() => onOpenChat(chat.id)}
              onRename={(title) => onRenameChat(chat.id, title)}
            />
          ))
        )}
      </ScrollArea>
      <div className="border-border/60 grid grid-cols-3 gap-1 border-t p-2">
        <Button className="h-auto flex-col gap-0.5 py-1.5 text-[11px]" onClick={onMemory} size="sm" variant="ghost">
          <BrainIcon className="size-4" />
          Memory{memoryCount ? ` · ${memoryCount}` : ""}
        </Button>
        <Button className="h-auto flex-col gap-0.5 py-1.5 text-[11px]" onClick={onKnowledge} size="sm" variant="ghost">
          <BookOpenIcon className="size-4" />
          Knowledge
        </Button>
        <Button className="h-auto flex-col gap-0.5 py-1.5 text-[11px]" onClick={onContacts} size="sm" variant="ghost">
          <UsersIcon className="size-4" />
          Contacts
        </Button>
      </div>
    </aside>
  );
}
