"use client";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { ThinkingIndicator } from "@/components/ai-elements/thinking-indicator";
import { ConnectionsDialog, type Connection } from "@/components/connections-dialog";
import { ContactsDialog } from "@/components/contacts-dialog";
import { EmailApprovalCard, type EmailDraft } from "@/components/email-approval-card";
import { KnowledgeDialog } from "@/components/knowledge-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import {
  collectKnownEmails,
  ToolResultCard,
  type CardContext,
} from "@/components/tool-cards";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useKeys } from "@/hooks/use-keys";
import {
  jobKeys,
  type JobResult,
  type SavedJob,
  type TrackerStatus,
} from "@/lib/tool-outputs";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from "ai";
import {
  BrainIcon,
  CheckCircle2Icon,
  CircleStopIcon,
  EllipsisIcon,
  FileSpreadsheetIcon,
  KeySquareIcon,
  MailIcon,
  MailSearchIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  PlugIcon,
  SparklesIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
}

interface KnowledgeItem {
  id: string;
  title: string | null;
  preview: string;
  createdAt: number;
}

interface ContactItem {
  id: string;
  name: string | null;
  email: string | null;
  emailStatus: string | null;
  title: string | null;
  company: string | null;
  domain: string | null;
  linkedinUrl: string | null;
  source?: string;
  lastEmailedAt?: number | null;
}

/** Mailbox tools: shown as the email itself, with buttons to approve. */
const EMAIL_TOOL_MODES: Record<string, "send" | "draft"> = {
  composio_send_email: "send",
  composio_create_draft: "draft",
};

export default function Page() {
  const { username, keys, saveKeys, saveAs, switchUser, ready } = useKeys();
  const composioApiKey = keys?.composioApiKey ?? "";
  const composioUserId = keys?.composioUserId ?? "default";
  const [settingsOpen, setSettingsOpenState] = useState(
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).has("settings")
      : false,
  );
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  // The Google Sheet tracker (see src/lib/tracker.ts).
  const [tracker, setTracker] = useState<TrackerStatus | null>(null);
  const [trackerSyncing, setTrackerSyncing] = useState(false);
  // Jobs saved since the last tracker refresh.
  const [justSavedJobs, setJustSavedJobs] = useState<SavedJob[]>([]);
  const lastAutoSyncRef = useRef(0);
  const previousStatusRef = useRef<string>("ready");
  // First message of a just-created chat, sent once its Chat instance exists.
  const pendingSendRef = useRef<{ chatId: string; text: string } | null>(null);
  const justCreatedIdRef = useRef<string | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        // `id` is the useChat id (the chat row id). It must be sent on every
        // request — including the automatic one after a Send approval — while
        // `extraBody` carries per-call values from sendMessage(..., { body }).
        prepareSendMessagesRequest: ({ id, messages, body: extraBody }) => ({
          body: { messages, keys, chatId: id === "new" ? null : id, ...extraBody },
        }),
      }),
    [keys],
  );

  const { messages, sendMessage, status, stop, error, setMessages, addToolApprovalResponse } =
    useChat({
      id: activeChatId ?? "new",
      onFinish: () => void refreshChats(),
      // After Send / Don't send is clicked, continue the turn automatically.
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      transport,
    });

  // Load a chat's stored messages in an effect keyed on `activeChatId`:
  // useChat creates a brand-new Chat instance whenever its `id` prop
  // changes, so `setMessages` must run AFTER that re-render — calling it
  // directly from the click handler would write into the previous (dead)
  // instance and the thread would appear lost.
  const openChat = useCallback(
    (chatId: string) => {
      if (chatId === activeChatId) return;
      setActiveChatId(chatId);
    },
    [activeChatId],
  );

  useEffect(() => {
    if (!activeChatId) return;
    // Skip loading right after creating a chat: its first message is being
    // sent by the pendingSend effect — a DB fetch would stomp the in-flight
    // stream with an empty/stale snapshot.
    if (justCreatedIdRef.current === activeChatId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/chats", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: activeChatId }),
        });
        if (!res.ok) throw new Error(`Failed to load chat (${res.status})`);
        const data = (await res.json()) as { messages?: UIMessage[] };
        if (!cancelled) setMessages(data.messages ?? []);
      } catch {
        if (!cancelled) setMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeChatId, setMessages]);

  const [input, setInput] = useState("");

  const busy = status === "submitted" || status === "streaming";
  const configured = Boolean(keys?.llmApiKey && keys?.llmModel);

  // Show the thinking indicator while the request is in flight but the
  // response has no visible content yet (no streamed text, no tool calls).
  const lastMessage = messages.at(-1);
  const showThinking =
    status === "submitted" ||
    (status === "streaming" &&
      (!lastMessage ||
        (lastMessage.role === "assistant" &&
          !lastMessage.parts.some(
            (part) =>
              (part.type === "text" && part.text.trim()) ||
              part.type.startsWith("tool-"),
          ))));

  const refreshChats = useCallback(async () => {
    const res = await fetch("/api/chats");
    const data = (await res.json()) as { chats?: ChatSummary[] };
    setChats(data.chats ?? []);
  }, []);

  const refreshKnowledge = useCallback(async () => {
    const res = await fetch("/api/knowledge");
    const data = (await res.json()) as { items?: KnowledgeItem[] };
    setKnowledgeItems(data.items ?? []);
  }, []);

  /**
   * A chat row is created up-front (POST /api/chats) so the server knows
   * where to persist from the very first message — no ghost duplicate chats.
   *
   * The actual send is deferred to an effect: flipping `activeChatId` makes
   * useChat swap to a fresh Chat instance, so `sendMessage` must be called
   * with the binding from the NEW instance. Calling it here (closure-captured
   * from the old "new" instance) renders the first thread into a dead chat.
   */
  const handleSend = useCallback(
    async ({ text }: { text: string }) => {
      if (!text.trim() || busy) return;
      if (!configured) {
        setSettingsOpenState(true);
        return;
      }
      if (activeChatId) {
        await sendMessage({ text }, { body: { chatId: activeChatId } });
        return;
      }
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: text.trim().slice(0, 60) }),
      });
      const data = (await res.json()) as { chat?: { id: string } };
      const chatId = data.chat?.id ?? null;
      if (!chatId) return;
      justCreatedIdRef.current = chatId;
      pendingSendRef.current = { chatId, text };
      setActiveChatId(chatId);
      void refreshChats();
    },
    [activeChatId, busy, configured, refreshChats, sendMessage],
  );

  // Emails found anywhere in this chat show up in earlier people lists.
  const knownEmails = useMemo(() => collectKnownEmails(messages), [messages]);

  // Fire the deferred first message once the new chat instance exists.
  useEffect(() => {
    const pending = pendingSendRef.current;
    if (!pending || pending.chatId !== activeChatId) return;
    pendingSendRef.current = null;
    justCreatedIdRef.current = null;
    void sendMessage({ text: pending.text }, { body: { chatId: pending.chatId } });
  }, [activeChatId, sendMessage]);

  // Initial load — deferred via setTimeout so the fetches don't synchronously
  // setState during mount.
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      void refreshChats();
      void refreshKnowledge();
    }, 0);
    return () => clearTimeout(timer);
  }, [ready, refreshChats, refreshKnowledge]);

  // Which mailbox (if any) is connected — drives the Gmail badge.
  useEffect(() => {
    if (!composioApiKey) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/composio/connections", {
          headers: { "x-composio-key": composioApiKey, "x-composio-user": composioUserId },
        });
        const data = (await res.json()) as { connections?: Connection[] };
        if (!cancelled && res.ok) setConnections(data.connections ?? []);
      } catch {
        // badge just stays "not connected"
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [composioApiKey, composioUserId]);

  // ---------- Google Sheet tracker ----------

  const syncTracker = useCallback(async () => {
    if (!composioApiKey) return;
    setTrackerSyncing(true);
    try {
      const res = await fetch("/api/tracker", {
        method: "POST",
        headers: { "x-composio-key": composioApiKey, "x-composio-user": composioUserId },
      });
      const data = (await res.json()) as { status?: TrackerStatus };
      if (data.status) setTracker(data.status);
    } catch {
      // the next refresh shows what happened
    } finally {
      setTrackerSyncing(false);
    }
  }, [composioApiKey, composioUserId]);

  const refreshTracker = useCallback(async () => {
    if (!composioApiKey) return;
    try {
      const res = await fetch("/api/tracker", {
        headers: { "x-composio-key": composioApiKey, "x-composio-user": composioUserId },
      });
      if (!res.ok) return;
      const status = (await res.json()) as TrackerStatus;
      setTracker(status);
      const waiting = status.pending.jobs + status.pending.contacts + status.pending.emails;
      // Google Sheets was just connected (no sheet yet), or rows are left over
      // from a slow or failed sync: sync now, at most once a minute.
      if (
        status.connected &&
        !status.syncing &&
        (!status.url || waiting > 0) &&
        Date.now() - lastAutoSyncRef.current > 60_000
      ) {
        lastAutoSyncRef.current = Date.now();
        void syncTracker();
      }
    } catch {
      // keep the last known status
    }
  }, [composioApiKey, composioUserId, syncTracker]);

  const sheetsConnectionId =
    connections.find((c) => c.toolkitSlug === "googlesheets" && c.status === "ACTIVE")?.id ??
    null;

  // On load, and whenever Google Sheets gets connected or disconnected.
  useEffect(() => {
    const timer = setTimeout(() => void refreshTracker(), 0);
    return () => clearTimeout(timer);
  }, [refreshTracker, sheetsConnectionId]);

  // After each reply: its tools may have logged jobs, contacts or emails.
  useEffect(() => {
    const was = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status !== "ready" || (was !== "streaming" && was !== "submitted")) return;
    const timer = setTimeout(() => void refreshTracker(), 1500);
    return () => clearTimeout(timer);
  }, [status, refreshTracker]);

  const saveJob = useCallback(
    async (job: JobResult, source?: string) => {
      try {
        const res = await fetch("/api/tracker/jobs", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-composio-key": composioApiKey,
            "x-composio-user": composioUserId,
          },
          body: JSON.stringify({ job, source }),
        });
        const data = (await res.json()) as { job?: SavedJob };
        const saved = data.job;
        if (res.ok && saved) setJustSavedJobs((prev) => [...prev, saved]);
      } catch {
        // the Save button stays available
      }
      void refreshTracker();
    },
    [composioApiKey, composioUserId, refreshTracker],
  );

  // Status of every saved job, by link and by title + company.
  const savedJobStatus = useMemo(() => {
    const index = new Map<string, string>();
    // The server's list goes last so its (newer) statuses win.
    for (const job of [...justSavedJobs, ...(tracker?.savedJobs ?? [])]) {
      for (const key of jobKeys(job)) index.set(key, job.status);
    }
    return index;
  }, [justSavedJobs, tracker]);

  // What the result cards need: most buttons send a chat message as the
  // user; Save on a job goes straight to the tracker.
  const cardContext: CardContext = {
    onAction: (text) => void handleSend({ text }),
    disabled: busy || !configured,
    knownEmails,
    jobStatus: (job) =>
      jobKeys(job)
        .map((key) => savedJobStatus.get(key))
        .find(Boolean),
    onSaveJob: saveJob,
    trackerConnected: Boolean(tracker?.connected),
  };

  // Composio's sign-in page sends the user back to /?connected=<toolkit>
  // (in the tab it opened): show the Connections dialog there.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("connected")) return;
    const timer = setTimeout(() => {
      setConnectionsOpen(true);
      params.delete("connected");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Contacts are refreshed right before opening their dialog.
  const openContacts = useCallback(() => {
    setContactsOpen(true);
    setLoadingContacts(true);
    fetch("/api/contacts")
      .then((res) => res.json() as Promise<{ contacts?: ContactItem[] }>)
      .then((data) => setContacts(data.contacts ?? []))
      .catch(() => setContacts([]))
      .finally(() => setLoadingContacts(false));
  }, []);

  const newChat = () => {
    setActiveChatId(null);
    setMessages([]);
  };
  const renameChat = useCallback(
    async (chatId: string, title: string) => {
      await fetch("/api/chats", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: chatId, title }),
      });
      void refreshChats();
    },
    [refreshChats],
  );
  const removeChat = async (chatId: string) => {
    await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`, {
      method: "DELETE",
    });
    if (chatId === activeChatId) newChat();
    void refreshChats();
  };

  if (!ready) return null;

  const suggestions = [
    "Find remote backend engineer jobs posted in the last week.",
    "I applied to a backend role at Stripe last week — find the recruiter and draft a follow-up.",
    "Find who handles hiring at vercel.com and get their email.",
  ];

  const mailbox = connections.find(
    (c) => (c.toolkitSlug === "gmail" || c.toolkitSlug === "outlook") && c.status === "ACTIVE",
  );
  const trackerWaiting = tracker
    ? tracker.pending.jobs + tracker.pending.contacts + tracker.pending.emails
    : 0;
  const trackerTip = !tracker?.connected
    ? tracker?.url
      ? "Google Sheets is disconnected, so new activity isn't logged. Click to open the sheet."
      : "Connect Google Sheets to log saved jobs, contacts and sent emails to a spreadsheet"
    : !tracker.url
      ? trackerSyncing
        ? "Creating your tracker sheet…"
        : "Tracker sheet not created yet — click to set it up"
      : tracker.lastError
        ? `Last sync failed: ${tracker.lastError}`
        : trackerSyncing || tracker.syncing
          ? "Updating your tracker…"
          : trackerWaiting
            ? `${trackerWaiting} change${trackerWaiting === 1 ? "" : "s"} waiting to be logged`
            : "Open your tracker: saved jobs, contacts and sent emails";
  const toolStatus = [
    {
      label: "LLM",
      on: Boolean(keys?.llmApiKey),
      tip: keys?.llmApiKey ? `${keys.llmProvider} · ${keys.llmModel}` : "LLM key missing — add it in API keys",
    },
    {
      label: "CleanList",
      on: Boolean(keys?.cleanlistApiKey),
      tip: keys?.cleanlistApiKey
        ? "People search and email lookup enabled"
        : "CleanList key missing — add it in API keys",
    },
    {
      label: "Composio",
      on: Boolean(keys?.composioApiKey),
      tip: keys?.composioApiKey
        ? "Job search and sending enabled"
        : "Composio key missing — add it in API keys",
    },
  ];

  return (
    <div className="bg-background flex h-dvh overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`border-border/60 bg-sidebar/40 flex w-64 shrink-0 flex-col border-r transition-all ${
          sidebarOpen ? "" : "hidden"
        }`}
      >
        <div className="flex items-center gap-2 px-4 py-4">
          <MailSearchIcon className="size-5" />
          <span className="font-heading text-sm font-bold tracking-tight">
            Outreach
          </span>
        </div>
        <div className="px-3">
          <Button
            className="w-full justify-start"
            onClick={newChat}
            size="sm"
            variant="outline"
          >
            <MessageSquarePlusIcon className="size-4" /> New chat
          </Button>
        </div>
        <ScrollArea className="mt-4 flex-1 px-2">
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
                onDelete={() => void removeChat(chat.id)}
                onOpen={() => openChat(chat.id)}
                onRename={(title) => void renameChat(chat.id, title)}
              />
            ))
          )}
        </ScrollArea>
        <div className="border-border/60 flex gap-1 border-t p-2">
          <Button onClick={() => setKnowledgeOpen(true)} size="sm" variant="ghost">
            <BrainIcon className="size-4" /> Knowledge
          </Button>
          <Button onClick={openContacts} size="sm" variant="ghost">
            <UsersIcon className="size-4" /> Contacts
          </Button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border/60 flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              aria-label="Toggle sidebar"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              size="icon-sm"
              variant="ghost"
            >
              <MailSearchIcon className="size-5" />
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            {toolStatus.map((t) => (
              <Tooltip key={t.label}>
                <TooltipTrigger asChild>
                  <Badge
                    className={`rounded-full text-[10px] ${
                      t.on ? "" : "text-muted-foreground opacity-60"
                    }`}
                    variant={t.on ? "secondary" : "outline"}
                  >
                    {t.on ? (
                      <CheckCircle2Icon className="size-3 text-green-600" />
                    ) : (
                      <CircleStopIcon className="size-3" />
                    )}
                    {t.label}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{t.tip}</TooltipContent>
              </Tooltip>
            ))}
            {keys?.composioApiKey ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={() => setConnectionsOpen(true)} type="button">
                    <Badge
                      className={`rounded-full text-[10px] ${
                        mailbox ? "" : "text-muted-foreground opacity-60"
                      }`}
                      variant={mailbox ? "secondary" : "outline"}
                    >
                      {mailbox ? (
                        <CheckCircle2Icon className="size-3 text-green-600" />
                      ) : (
                        <MailIcon className="size-3" />
                      )}
                      {mailbox?.toolkitSlug === "outlook" ? "Outlook" : "Gmail"}
                    </Badge>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {mailbox
                    ? `Sending from ${mailbox.account ?? "your connected mailbox"}`
                    : "No mailbox connected — click to connect Gmail"}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {keys?.composioApiKey ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  {tracker?.url ? (
                    <a href={tracker.url} rel="noopener noreferrer" target="_blank">
                      <Badge
                        className={`rounded-full text-[10px] ${
                          tracker.connected ? "" : "text-muted-foreground opacity-60"
                        }`}
                        variant={tracker.connected ? "secondary" : "outline"}
                      >
                        <FileSpreadsheetIcon
                          className={`size-3 ${
                            !tracker.connected
                              ? ""
                              : tracker.lastError
                                ? "text-amber-600"
                                : "text-green-600"
                          }`}
                        />
                        Tracker
                      </Badge>
                    </a>
                  ) : (
                    <button onClick={() => setConnectionsOpen(true)} type="button">
                      <Badge
                        className="text-muted-foreground rounded-full text-[10px] opacity-60"
                        variant="outline"
                      >
                        <FileSpreadsheetIcon className="size-3" />
                        Tracker
                      </Badge>
                    </button>
                  )}
                </TooltipTrigger>
                <TooltipContent>{trackerTip}</TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Connections"
                  onClick={() => setConnectionsOpen(true)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <PlugIcon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Connected apps (Composio)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="API keys"
                  onClick={() => setSettingsOpenState(true)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <KeySquareIcon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>API keys</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <Conversation className="flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl">
            {messages.length === 0 ? (
              <ConversationEmptyState
                description="Find open roles, reach the right person, and email them from your own Gmail."
                icon={<SparklesIcon className="size-10" />}
                title="Land the interview"
              >
                <div className="flex flex-col gap-2 pt-6">
                  {suggestions.map((suggestion) => (
                    <button
                      className="border-border/60 hover:bg-accent/50 rounded-lg border px-4 py-3 text-left text-sm"
                      key={suggestion}
                      onClick={() => {
                        if (configured) void handleSend({ text: suggestion });
                      }}
                      type="button"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </ConversationEmptyState>
            ) : (
              messages.map((message) => (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    {message.parts.map((part, index) => {
                      if (part.type === "text" && part.text.trim()) {
                        return (
                          <MessageResponse key={index}>{part.text}</MessageResponse>
                        );
                      }
                      if (!isToolUIPart(part)) return null;
                      const emailMode = EMAIL_TOOL_MODES[getToolName(part)];
                      if (emailMode) {
                        // Only the latest message can still be approved; an
                        // older unanswered request was skipped by moving on.
                        const approvalId =
                          part.state === "approval-requested" &&
                          !part.approval.isAutomatic &&
                          message.id === messages.at(-1)?.id
                            ? part.approval.id
                            : null;
                        return (
                          <EmailApprovalCard
                            approved={
                              part.state === "approval-responded"
                                ? part.approval.approved
                                : undefined
                            }
                            draft={(part.input ?? {}) as EmailDraft}
                            errorText={part.state === "output-error" ? part.errorText : undefined}
                            key={part.toolCallId}
                            mode={emailMode}
                            onRespond={
                              approvalId
                                ? (approved) =>
                                    void addToolApprovalResponse({
                                      id: approvalId,
                                      approved,
                                      ...(approved
                                        ? {}
                                        : {
                                            reason: `The user clicked "${
                                              emailMode === "send" ? "Don't send" : "Don't save"
                                            }".`,
                                          }),
                                    })
                                : undefined
                            }
                            output={part.state === "output-available" ? part.output : undefined}
                            state={part.state}
                          />
                        );
                      }
                      return (
                        <ToolResultCard ctx={cardContext} key={part.toolCallId} part={part} />
                      );
                    })}
                  </MessageContent>
                </Message>
              ))
            )}
            {error ? (
              <div
                className="text-destructive mx-auto max-w-md rounded-md border px-4 py-3 text-center text-sm"
                role="alert"
              >
                {error.message}
              </div>
            ) : null}
            {showThinking ? (
              <Message from="assistant">
                <MessageContent>
                  <ThinkingIndicator />
                </MessageContent>
              </Message>
            ) : null}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="border-border/60 mx-auto w-full max-w-3xl border-t px-4 py-3">
          <PromptInput
            className="border-border/60 mx-auto max-w-[90ch]"
            onSubmit={({ text }) => {
              if (!text.trim() || busy) return;
              if (!configured) {
                setSettingsOpenState(true);
                return;
              }
              setInput("");
              void handleSend({ text });
            }}
          >
            <PromptInputTextarea
              autoFocus
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                configured
                  ? "Which company did you apply to?"
                  : "Add your API keys to get started..."
              }
              value={input}
            />
            <PromptInputSubmit
              disabled={!input.trim() && !busy}
              onStop={stop}
              status={status}
            />
          </PromptInput>
          <div className="text-muted-foreground/70 mt-2 flex items-center justify-center gap-2 text-center text-[11px]">
            Jobs via Composio · people and emails via CleanList (1 credit per
            email found) · emails go out from your Gmail only after you click Send.
          </div>
        </div>
      </div>

      <SettingsDialog
        keys={keys!}
        onOpenChange={setSettingsOpenState}
        onSave={async (name, next) => {
          if (username && name.toLowerCase() === username) {
            await saveKeys(next);
          } else {
            await saveAs(name, next);
          }
        }}
        onSwitch={async (name) => {
          await switchUser(name);
        }}
        open={settingsOpen}
        username={username}
      />
      <ConnectionsDialog
        composioApiKey={composioApiKey}
        composioUserId={composioUserId}
        onConnectionsChange={setConnections}
        onOpenChange={setConnectionsOpen}
        onSyncTracker={() => void syncTracker()}
        open={connectionsOpen}
        tracker={tracker}
        trackerSyncing={trackerSyncing}
      />
      <KnowledgeDialog
        items={knowledgeItems}
        keys={keys}
        onOpenChange={setKnowledgeOpen}
        onStored={() => void refreshKnowledge()}
        open={knowledgeOpen}
      />
      <ContactsDialog
        contacts={contacts}
        loading={loadingContacts}
        onOpenChange={setContactsOpen}
        open={contactsOpen}
      />
    </div>
  );
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
          active ? "bg-accent" : "hover:bg-accent/50"
        }`}
      >
        <button
          className="min-w-0 flex-1 truncate text-left"
          onClick={onOpen}
          type="button"
        >
          {chat.title}
        </button>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Chat options"
            className="text-muted-foreground hover:text-foreground -m-0.5 rounded-sm p-1 shrink-0 opacity-60 transition-opacity hover:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
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
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={onDelete}
        >
          <Trash2Icon className="size-3" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}