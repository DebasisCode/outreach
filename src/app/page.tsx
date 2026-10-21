"use client";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { ChatSidebar, type ChatSummary } from "@/components/chat-sidebar";
import { CommandPalette, type PaletteAction } from "@/components/command-palette";
import { Composer } from "@/components/composer";
import { ConnectionsDialog, type Connection } from "@/components/connections-dialog";
import { ContactsDialog } from "@/components/contacts-dialog";
import { EmailApprovalCard, type EmailDraft } from "@/components/email-approval-card";
import { Kbd } from "@/components/kbd";
import { KnowledgeDialog } from "@/components/knowledge-dialog";
import { MemoryDialog } from "@/components/memory-dialog";
import { Notices, type Notice } from "@/components/notices";
import { SettingsDialog } from "@/components/settings-dialog";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { StatusLine } from "@/components/status-line";
import { collectKnownEmails, ToolResultCard, type CardContext } from "@/components/tool-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Welcome } from "@/components/welcome";
import { WorkingIndicator } from "@/components/working-indicator";
import { useHotkeys, useIsMac } from "@/hooks/use-hotkeys";
import { useKeys } from "@/hooks/use-keys";
import { useTheme } from "@/hooks/use-theme";
import { findCommand, parseSlash } from "@/lib/commands";
import { chatToMarkdown, downloadFile } from "@/lib/export-chat";
import { formatKeys } from "@/lib/shortcuts";
import {
  jobKeys,
  parseToolOutput,
  type ContextInfo,
  type EmailToolOutput,
  type JobResult,
  type MemoryItem,
  type SavedJob,
  type TrackerStatus,
} from "@/lib/tool-outputs";
import { LLM_PROVIDERS } from "@/lib/types";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from "ai";
import {
  BookOpenIcon,
  BrainIcon,
  BriefcaseBusinessIcon,
  CheckCircle2Icon,
  CircleStopIcon,
  CommandIcon,
  CopyIcon,
  DownloadIcon,
  FileSpreadsheetIcon,
  HashIcon,
  KeyboardIcon,
  KeySquareIcon,
  MailIcon,
  MoonIcon,
  PanelLeftIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  ShrinkIcon,
  SlashIcon,
  SparklesIcon,
  SquarePenIcon,
  SunIcon,
  UserSearchIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

const SUGGESTIONS = [
  "Find remote backend engineer jobs posted in the last week.",
  "I applied to a backend role at Stripe last week — find the recruiter and draft a follow-up.",
  "Find who handles hiring at vercel.com and get their email.",
];

const NARROW_SCREEN = "(max-width: 767px)";
const isNarrowScreen = () => window.matchMedia(NARROW_SCREEN).matches;

const HISTORY_KEY = "outreach-prompt-history";
const HISTORY_MAX = 100;

function readPromptHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const messageText = (message: UIMessage) =>
  message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();

/** True when the message already sent (or drafted) an email — not safe to redo. */
const touchedMailbox = (message: UIMessage) =>
  message.parts.some((part) => {
    if (!isToolUIPart(part) || !EMAIL_TOOL_MODES[getToolName(part)]) return false;
    if (part.state !== "output-available") return false;
    const output = parseToolOutput<EmailToolOutput>(part.output);
    return Boolean(output?.sent || output?.drafted);
  });

const focusSoon = (element: HTMLTextAreaElement | null) =>
  setTimeout(() => {
    element?.focus();
    const end = element?.value.length ?? 0;
    element?.setSelectionRange(end, end);
  }, 60);

export default function Page() {
  const { username, keys, saveKeys, saveAs, switchUser, ready } = useKeys();
  const composioApiKey = keys?.composioApiKey ?? "";
  const composioUserId = keys?.composioUserId ?? "default";
  const mac = useIsMac();
  const { dark, toggle: toggleTheme } = useTheme();

  const [settingsOpen, setSettingsOpenState] = useState(
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).has("settings")
      : false,
  );
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<"root" | "models">("root");
  // On a phone the sidebar is a drawer, closed until asked for.
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === "undefined" ? true : !window.matchMedia(NARROW_SCREEN).matches,
  );
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
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  // How full the model's context is, and where the chat was compacted.
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [compacting, setCompacting] = useState(false);
  // Messages typed while the assistant is working; sent one by one after.
  const [queue, setQueue] = useState<string[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [promptHistory, setPromptHistory] = useState<string[]>(readPromptHistory);
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);
  const [input, setInput] = useState("");

  const lastAutoSyncRef = useRef(0);
  const previousStatusRef = useRef<string>("ready");
  const noticeIdRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // The next send replaces messages after an edited one (Edit).
  const rewindRef = useRef(false);
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
        // `trigger` tells the server a Retry replaced the last reply.
        prepareSendMessagesRequest: ({ id, messages, body: extraBody, trigger }) => ({
          body: { messages, keys, chatId: id === "new" ? null : id, trigger, ...extraBody },
        }),
      }),
    [keys],
  );

  const {
    messages,
    sendMessage,
    regenerate,
    status,
    stop,
    error,
    setMessages,
    addToolApprovalResponse,
  } = useChat({
    id: activeChatId ?? "new",
    onFinish: () => void refreshChats(),
    onData: (part) => {
      if (part.type === "data-context") setContextInfo(part.data as ContextInfo);
    },
    // After Send / Don't send is clicked, continue the turn automatically.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    transport,
  });

  const busy = status === "submitted" || status === "streaming";
  const configured = Boolean(keys?.llmApiKey && keys?.llmModel);

  // ---------- notices ----------

  const notify = useCallback(
    (text: string, options: { tone?: Notice["tone"]; action?: Notice["action"] } = {}) => {
      noticeIdRef.current += 1;
      const id = noticeIdRef.current;
      setNotices((prev) => [...prev.slice(-2), { id, text, ...options }]);
      setTimeout(
        () => setNotices((prev) => prev.filter((notice) => notice.id !== id)),
        options.action ? 6_000 : 3_500,
      );
    },
    [],
  );
  const dismissNotice = useCallback(
    (id: number) => setNotices((prev) => prev.filter((notice) => notice.id !== id)),
    [],
  );

  // ---------- chats ----------

  // Load a chat's stored messages in an effect keyed on `activeChatId`:
  // useChat creates a brand-new Chat instance whenever its `id` prop
  // changes, so `setMessages` must run AFTER that re-render — calling it
  // directly from the click handler would write into the previous (dead)
  // instance and the thread would appear lost.
  const openChat = useCallback(
    (chatId: string) => {
      if (chatId === activeChatId) return;
      setQueue([]);
      setContextInfo(null);
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
        const data = (await res.json()) as { messages?: UIMessage[]; context?: ContextInfo };
        if (cancelled) return;
        setMessages(data.messages ?? []);
        setContextInfo(data.context ?? null);
      } catch {
        if (!cancelled) setMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeChatId, setMessages]);

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

  const refreshMemories = useCallback(async () => {
    try {
      const res = await fetch("/api/memory");
      const data = (await res.json()) as { memories?: MemoryItem[] };
      setMemories(data.memories ?? []);
    } catch {
      // keep the list we have
    }
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
        const rewind = rewindRef.current;
        rewindRef.current = false;
        await sendMessage(
          { text },
          { body: { chatId: activeChatId, ...(rewind ? { rewind: true } : {}) } },
        );
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
      void refreshMemories();
    }, 0);
    return () => clearTimeout(timer);
  }, [ready, refreshChats, refreshKnowledge, refreshMemories]);

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

  // After each reply: its tools may have logged jobs, contacts or emails, or
  // saved memories.
  useEffect(() => {
    const was = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status !== "ready" || (was !== "streaming" && was !== "submitted")) return;
    const timer = setTimeout(() => {
      void refreshTracker();
      void refreshMemories();
    }, 1500);
    return () => clearTimeout(timer);
  }, [status, refreshTracker, refreshMemories]);

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

  const openTracker = useCallback(() => {
    if (tracker?.url) {
      window.open(tracker.url, "_blank", "noopener,noreferrer");
      return;
    }
    setConnectionsOpen(true);
    notify("Connect Google Sheets to start your tracker.");
  }, [notify, tracker]);

  // ---------- memory ----------

  const forgetMemory = useCallback(
    async (id: string) => {
      await fetch(`/api/memory?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await refreshMemories();
    },
    [refreshMemories],
  );

  const addMemory = useCallback(
    async (content: string, options: { quiet?: boolean } = {}): Promise<boolean> => {
      try {
        const res = await fetch("/api/memory", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
        const data = (await res.json()) as { memory?: MemoryItem; error?: string };
        if (!res.ok || !data.memory) {
          notify(data.error ?? "Couldn't save to memory.", { tone: "error" });
          return false;
        }
        await refreshMemories();
        const saved = data.memory;
        if (!options.quiet) {
          notify(`Remembered: ${saved.content}`, {
            action: { label: "Undo", run: () => void forgetMemory(saved.id) },
          });
        }
        return true;
      } catch {
        notify("Couldn't save to memory.", { tone: "error" });
        return false;
      }
    },
    [forgetMemory, notify, refreshMemories],
  );

  const updateMemory = useCallback(
    async (id: string, content: string): Promise<boolean> => {
      const res = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, content }),
      });
      if (!res.ok) {
        notify("Couldn't update that memory.", { tone: "error" });
        return false;
      }
      await refreshMemories();
      return true;
    },
    [notify, refreshMemories],
  );

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
    onForgetMemory: forgetMemory,
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

  const newChat = useCallback(() => {
    setActiveChatId(null);
    setMessages([]);
    setQueue([]);
    setContextInfo(null);
    setInput("");
    rewindRef.current = false;
    focusSoon(textareaRef.current);
  }, [setMessages]);

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

  /** Alt+↑ / Alt+↓: the newer / older chat in the sidebar. */
  const stepChat = (delta: number) => {
    if (chats.length === 0) return;
    const index = chats.findIndex((chat) => chat.id === activeChatId);
    const next = index === -1 ? 0 : Math.min(chats.length - 1, Math.max(0, index + delta));
    const target = chats[next];
    if (target && target.id !== activeChatId) openChat(target.id);
  };

  // ---------- compaction, export, models ----------

  const compactChat = useCallback(
    async (focus?: string) => {
      if (!activeChatId || messages.length === 0) {
        notify("Nothing to compact yet.");
        return;
      }
      if (busy) {
        notify("Wait until the assistant finishes, then /compact.");
        return;
      }
      setCompacting(true);
      try {
        const res = await fetch("/api/chats/compact", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chatId: activeChatId, keys, focus }),
        });
        const data = (await res.json()) as {
          compacted?: boolean;
          context?: ContextInfo;
          error?: string;
        };
        if (!res.ok) {
          notify(data.error ?? "Couldn't compact this chat.", { tone: "error" });
          return;
        }
        if (data.context) setContextInfo(data.context);
        notify(
          data.compacted
            ? "Compacted — the assistant now reads a summary of the earlier messages."
            : "Nothing new to compact.",
        );
      } catch {
        notify("Couldn't compact this chat.", { tone: "error" });
      } finally {
        setCompacting(false);
      }
    },
    [activeChatId, busy, keys, messages.length, notify],
  );

  const exportChat = () => {
    if (messages.length === 0) {
      notify("Nothing to export yet.");
      return;
    }
    const title = chats.find((chat) => chat.id === activeChatId)?.title ?? "Chat";
    const slug = title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "chat";
    downloadFile(`${slug}.md`, chatToMarkdown(title, messages));
  };

  const provider = LLM_PROVIDERS.find((item) => item.id === keys?.llmProvider);
  const paletteModels =
    keys?.llmProvider === "ollama"
      ? ollamaModels
      : [...new Set([keys?.llmModel ?? "", ...(provider?.models ?? [])].filter(Boolean))];

  const loadModels = useCallback(async () => {
    if (keys?.llmProvider !== "ollama" || ollamaModels) return;
    try {
      const res = await fetch("/api/ollama/models", {
        headers: { "x-ollama-key": keys.llmApiKey },
      });
      const data = (await res.json()) as { models?: string[] };
      setOllamaModels([...new Set([keys.llmModel, ...(data.models ?? [])].filter(Boolean))]);
    } catch {
      setOllamaModels([keys.llmModel]);
    }
  }, [keys, ollamaModels]);

  const openModelPicker = useCallback(() => {
    setPaletteMode("models");
    setPaletteOpen(true);
    void loadModels();
  }, [loadModels]);

  const pickModel = async (model: string) => {
    if (!keys || model === keys.llmModel) return;
    const ok = await saveKeys({ ...keys, llmModel: model });
    notify(ok ? `Model: ${model}` : "Couldn't switch the model — save a profile in API keys first.", {
      tone: ok ? "info" : "error",
    });
  };

  const startInput = (text: string) => {
    setInput(text);
    focusSoon(textareaRef.current);
  };

  // ---------- the chat box ----------

  const rememberPrompt = (text: string) => {
    const next = [...promptHistory.filter((item) => item !== text), text].slice(-HISTORY_MAX);
    setPromptHistory(next);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // history just isn't kept
    }
  };

  /** Runs a /command. Returns true when the box should be cleared. */
  const runCommand = (raw: string): boolean => {
    const parsed = parseSlash(raw);
    const command = parsed ? findCommand(parsed.name) : undefined;
    if (!parsed || !command) {
      notify(`Unknown command ${raw.split(/\s/)[0]} — type / to see the list.`, { tone: "error" });
      return false;
    }
    const { args } = parsed;
    if (command.prompt) {
      if (!args) {
        setInput(`/${command.name} `);
        return false;
      }
      void handleSend({ text: command.prompt(args) });
      return true;
    }
    switch (command.name) {
      case "new":
        newChat();
        return true;
      case "compact":
        void compactChat(args || undefined);
        return true;
      case "memory":
        setMemoryOpen(true);
        return true;
      case "remember":
        if (!args) {
          setInput("/remember ");
          return false;
        }
        void addMemory(args);
        return true;
      case "tracker":
        openTracker();
        return true;
      case "contacts":
        openContacts();
        return true;
      case "knowledge":
        setKnowledgeOpen(true);
        return true;
      case "connections":
        setConnectionsOpen(true);
        return true;
      case "model":
        openModelPicker();
        return true;
      case "keys":
        setSettingsOpenState(true);
        return true;
      case "theme":
        toggleTheme();
        return true;
      case "rename":
        if (!activeChatId) {
          notify("Start a chat first.");
          return true;
        }
        if (!args) {
          setInput("/rename ");
          return false;
        }
        void renameChat(activeChatId, args.slice(0, 100));
        return true;
      case "export":
        exportChat();
        return true;
      default:
        setShortcutsOpen(true);
        return true;
    }
  };

  const submitComposer = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      if (runCommand(text)) setInput("");
      return;
    }
    // "# fact" saves to memory, like Claude Code's # shortcut.
    if (/^#\s*\S/.test(text)) {
      rememberPrompt(text);
      setInput("");
      void addMemory(text.replace(/^#+\s*/, ""));
      return;
    }
    if (!configured) {
      setSettingsOpenState(true);
      return;
    }
    rememberPrompt(text);
    setInput("");
    if (busy) {
      setQueue((prev) => [...prev, text]);
      return;
    }
    void handleSend({ text });
  };

  // The email waiting for Send / Don't send, if any.
  const pendingApproval = useMemo(() => {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return null;
    for (const part of last.parts) {
      if (isToolUIPart(part) && part.state === "approval-requested" && !part.approval.isAutomatic) {
        return { id: part.approval.id, mode: EMAIL_TOOL_MODES[getToolName(part)] ?? "send" };
      }
    }
    return null;
  }, [messages]);

  const respondToApproval = useCallback(
    (id: string, mode: "send" | "draft", approved: boolean) =>
      void addToolApprovalResponse({
        id,
        approved,
        ...(approved
          ? {}
          : { reason: `The user clicked "${mode === "send" ? "Don't send" : "Don't save"}".` }),
      }),
    [addToolApprovalResponse],
  );

  // Send queued messages once the assistant is free (not while an email waits).
  useEffect(() => {
    if (status !== "ready" || queue.length === 0 || pendingApproval) return;
    const timer = setTimeout(() => {
      const [next, ...rest] = queue;
      setQueue(rest);
      void handleSend({ text: next });
    }, 250);
    return () => clearTimeout(timer);
  }, [status, queue, pendingApproval, handleSend]);

  const interrupt = () => {
    if (busy) {
      void stop();
      notify("Interrupted.");
      return;
    }
    if (pendingApproval) respondToApproval(pendingApproval.id, pendingApproval.mode, false);
  };

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => notify("Copied."),
      () => notify("Couldn't copy.", { tone: "error" }),
    );
  };

  const retry = () => {
    if (busy) return;
    setQueue([]);
    void regenerate();
  };

  /** Rewind to the last user message: it goes back in the box to edit. */
  const editMessage = (message: UIMessage) => {
    if (busy) return;
    const index = messages.findIndex((item) => item.id === message.id);
    if (index < 0) return;
    setMessages(messages.slice(0, index));
    rewindRef.current = true;
    setQueue([]);
    startInput(messageText(message));
  };

  // ---------- keyboard ----------

  const anyDialogOpen =
    settingsOpen ||
    connectionsOpen ||
    knowledgeOpen ||
    contactsOpen ||
    memoryOpen ||
    shortcutsOpen ||
    paletteOpen;

  useHotkeys([
    { combo: "mod+0", run: newChat, inInputs: true, when: () => !anyDialogOpen },
    {
      combo: "mod+k",
      run: () => {
        setPaletteMode("root");
        setPaletteOpen((open) => !open);
      },
      inInputs: true,
      when: () => paletteOpen || !anyDialogOpen,
    },
    {
      combo: "mod+/",
      run: () => setShortcutsOpen((open) => !open),
      inInputs: true,
      when: () => shortcutsOpen || !anyDialogOpen,
    },
    { combo: "mod+b", run: () => setSidebarOpen((open) => !open), when: () => !anyDialogOpen },
    { combo: "mod+,", run: () => setSettingsOpenState(true), when: () => !anyDialogOpen },
    { combo: "alt+arrowup", run: () => stepChat(-1), when: () => !anyDialogOpen },
    { combo: "alt+arrowdown", run: () => stepChat(1), when: () => !anyDialogOpen },
    {
      combo: "mod+enter",
      run: () => {
        if (pendingApproval) respondToApproval(pendingApproval.id, pendingApproval.mode, true);
      },
      inInputs: true,
      when: () => Boolean(pendingApproval) && !anyDialogOpen && !input.trim(),
    },
    { combo: "escape", run: interrupt, when: () => !anyDialogOpen && (busy || Boolean(pendingApproval)) },
    {
      combo: "/",
      run: () => textareaRef.current?.focus(),
      keepDefault: true,
      when: () => !anyDialogOpen,
    },
  ]);

  if (!ready) return null;

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

  const activeTitle = chats.find((chat) => chat.id === activeChatId)?.title ?? "New chat";
  const lastMessage = messages.at(-1);
  const lastUserId = [...messages].reverse().find((message) => message.role === "user")?.id;
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const lastPart = lastMessage?.role === "assistant" ? lastMessage.parts.at(-1) : undefined;
  const workingLabel =
    status === "submitted" || !lastPart
      ? "Thinking"
      : isToolUIPart(lastPart) &&
          (lastPart.state === "input-streaming" || lastPart.state === "input-available")
        ? "Working"
        : lastPart.type === "text"
          ? "Writing"
          : "Thinking";
  const compactedUpto = contextInfo?.compactedUpto ?? null;

  const paletteActions: PaletteAction[] = [
    { id: "new", group: "Chat", label: "New chat", keys: ["mod", "0"], icon: <SquarePenIcon />, run: newChat },
    {
      id: "compact",
      group: "Chat",
      label: "Compact chat (free up context)",
      icon: <ShrinkIcon />,
      keywords: ["summary", "context", "tokens"],
      run: () => void compactChat(),
    },
    { id: "export", group: "Chat", label: "Export chat as Markdown", icon: <DownloadIcon />, run: exportChat },
    { id: "rename", group: "Chat", label: "Rename chat…", icon: <PencilIcon />, run: () => startInput("/rename ") },
    { id: "jobs", group: "Outreach", label: "Search jobs…", icon: <BriefcaseBusinessIcon />, run: () => startInput("/jobs ") },
    {
      id: "recruiter",
      group: "Outreach",
      label: "Find a recruiter…",
      icon: <UserSearchIcon />,
      run: () => startInput("/recruiter "),
    },
    { id: "contacts", group: "Outreach", label: "Saved contacts", icon: <UsersIcon />, run: openContacts },
    {
      id: "tracker",
      group: "Outreach",
      label: tracker?.url ? "Open tracker sheet" : "Set up the tracker (Google Sheets)",
      icon: <FileSpreadsheetIcon />,
      run: openTracker,
    },
    ...(tracker?.connected
      ? [
          {
            id: "sync",
            group: "Outreach",
            label: "Sync tracker now",
            icon: <RefreshCwIcon />,
            run: () => void syncTracker(),
          },
        ]
      : []),
    { id: "memory", group: "Memory", label: "Open memory", icon: <BrainIcon />, run: () => setMemoryOpen(true) },
    { id: "remember", group: "Memory", label: "Remember a fact…", icon: <PlusIcon />, run: () => startInput("# ") },
    {
      id: "knowledge",
      group: "Memory",
      label: "Knowledge base (resume, notes)",
      icon: <BookOpenIcon />,
      run: () => setKnowledgeOpen(true),
    },
    {
      id: "model",
      group: "Settings",
      label: `Switch model · ${keys?.llmModel ?? "none"}`,
      icon: <SparklesIcon />,
      keepOpen: true,
      run: () => {
        setPaletteMode("models");
        void loadModels();
      },
    },
    { id: "connections", group: "Settings", label: "Connections", icon: <PlugIcon />, run: () => setConnectionsOpen(true) },
    {
      id: "keys",
      group: "Settings",
      label: "API keys",
      keys: ["mod", ","],
      icon: <KeySquareIcon />,
      run: () => setSettingsOpenState(true),
    },
    {
      id: "theme",
      group: "Settings",
      label: dark ? "Light theme" : "Dark theme",
      icon: dark ? <SunIcon /> : <MoonIcon />,
      run: toggleTheme,
    },
    {
      id: "sidebar",
      group: "Settings",
      label: sidebarOpen ? "Hide sidebar" : "Show sidebar",
      keys: ["mod", "B"],
      icon: <PanelLeftIcon />,
      run: () => setSidebarOpen((open) => !open),
    },
    {
      id: "shortcuts",
      group: "Settings",
      label: "Keyboard shortcuts",
      keys: ["mod", "/"],
      icon: <KeyboardIcon />,
      run: () => setShortcutsOpen(true),
    },
  ];

  return (
    <div className="bg-background flex h-dvh overflow-hidden">
      {sidebarOpen ? (
        <>
          {/* Phone: the sidebar slides over the chat; tap outside to close. */}
          <button
            aria-label="Close sidebar"
            className="fixed inset-0 z-30 bg-black/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
            type="button"
          />
          <ChatSidebar
            activeChatId={activeChatId}
            chats={chats}
            className="fixed inset-y-0 left-0 z-40 shadow-xl md:static md:z-auto md:shadow-none"
            mac={mac}
            memoryCount={memories.length}
            onContacts={openContacts}
            onDeleteChat={(id) => void removeChat(id)}
            onKnowledge={() => setKnowledgeOpen(true)}
            onMemory={() => setMemoryOpen(true)}
            onNewChat={() => {
              newChat();
              if (isNarrowScreen()) setSidebarOpen(false);
            }}
            onOpenChat={(id) => {
              openChat(id);
              if (isNarrowScreen()) setSidebarOpen(false);
            }}
            onRenameChat={(id, title) => void renameChat(id, title)}
          />
        </>
      ) : null}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border/60 flex items-center justify-between gap-3 border-b px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Toggle sidebar"
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <PanelLeftIcon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Sidebar <span className="text-muted-foreground ml-1">{formatKeys(["mod", "B"], mac)}</span>
              </TooltipContent>
            </Tooltip>
            <span className="truncate text-sm font-medium">{activeTitle}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {toolStatus.map((t) => (
              <Tooltip key={t.label}>
                <TooltipTrigger asChild>
                  <Badge
                    className={`hidden rounded-full text-[10px] lg:inline-flex ${
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
                  <button className="hidden sm:inline-flex" onClick={() => setConnectionsOpen(true)} type="button">
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
                    <a className="hidden sm:inline-flex" href={tracker.url} rel="noopener noreferrer" target="_blank">
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
                    <button className="hidden sm:inline-flex" onClick={() => setConnectionsOpen(true)} type="button">
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
            <Button
              className="text-muted-foreground ml-1 h-7 gap-2 px-2 font-normal"
              onClick={() => {
                setPaletteMode("root");
                setPaletteOpen(true);
              }}
              size="sm"
              variant="outline"
            >
              <SearchIcon className="size-3.5" />
              <span className="hidden text-xs md:inline">Commands</span>
              <Kbd className="h-4.5" keys={["mod", "K"]} mac={mac} />
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button aria-label="Toggle theme" onClick={toggleTheme} size="icon-sm" variant="ghost">
                  {dark ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{dark ? "Light theme" : "Dark theme"}</TooltipContent>
            </Tooltip>
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
              <TooltipContent>
                API keys <span className="text-muted-foreground ml-1">{formatKeys(["mod", ","], mac)}</span>
              </TooltipContent>
            </Tooltip>
          </div>
        </header>

        <Conversation className="flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl">
            {messages.length === 0 ? (
              <Welcome
                configured={configured}
                mac={mac}
                mailbox={mailbox?.account ?? (mailbox ? mailbox.toolkitSlug : null)}
                memoryCount={memories.length}
                model={keys?.llmModel ?? ""}
                onOpenSettings={() => setSettingsOpenState(true)}
                onSuggestion={(suggestion) => {
                  rememberPrompt(suggestion);
                  void handleSend({ text: suggestion });
                }}
                suggestions={SUGGESTIONS}
                trackerOn={Boolean(tracker?.connected && tracker.url)}
              />
            ) : (
              messages.map((message) => {
                const text = messageText(message);
                const canRetry =
                  !busy &&
                  message.role === "assistant" &&
                  message.id === lastAssistant?.id &&
                  message.id === lastMessage?.id &&
                  !touchedMailbox(message);
                const canEdit = !busy && message.role === "user" && message.id === lastUserId;
                return (
                  <div className="flex flex-col gap-2" key={message.id}>
                    <Message from={message.role}>
                      <MessageContent>
                        {message.parts.map((part, index) => {
                          if (part.type === "text" && part.text.trim()) {
                            return <MessageResponse key={index}>{part.text}</MessageResponse>;
                          }
                          if (!isToolUIPart(part)) return null;
                          const emailMode = EMAIL_TOOL_MODES[getToolName(part)];
                          if (emailMode) {
                            // Only the latest message can still be approved; an
                            // older unanswered request was skipped by moving on.
                            const approvalId =
                              part.state === "approval-requested" &&
                              !part.approval.isAutomatic &&
                              message.id === lastMessage?.id
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
                                mac={mac}
                                mode={emailMode}
                                onRespond={
                                  approvalId
                                    ? (approved) => respondToApproval(approvalId, emailMode, approved)
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
                      {text || canRetry || canEdit ? (
                        <MessageActions
                          className={`opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${
                            message.role === "user" ? "justify-end" : ""
                          }`}
                        >
                          {text ? (
                            <MessageAction label="Copy" onClick={() => copyText(text)} size="icon-xs" tooltip="Copy">
                              <CopyIcon className="size-3.5" />
                            </MessageAction>
                          ) : null}
                          {canEdit ? (
                            <MessageAction
                              label="Edit"
                              onClick={() => editMessage(message)}
                              size="icon-xs"
                              tooltip="Edit and resend"
                            >
                              <PencilIcon className="size-3.5" />
                            </MessageAction>
                          ) : null}
                          {canRetry ? (
                            <MessageAction label="Retry" onClick={retry} size="icon-xs" tooltip="Retry">
                              <RotateCcwIcon className="size-3.5" />
                            </MessageAction>
                          ) : null}
                        </MessageActions>
                      ) : null}
                    </Message>
                    {message.id === compactedUpto ? (
                      <div className="text-muted-foreground flex items-center gap-3 py-1 font-mono text-[11px]">
                        <span className="bg-border h-px flex-1" />
                        <span>✻ compacted · the assistant reads a summary of everything above</span>
                        <span className="bg-border h-px flex-1" />
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
            {error ? (
              <div
                className="text-destructive mx-auto max-w-md rounded-md border px-4 py-3 text-center text-sm"
                role="alert"
              >
                {error.message}
              </div>
            ) : null}
            {busy ? (
              <WorkingIndicator interruptKey={mac ? "esc" : "Esc"} label={workingLabel} />
            ) : null}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="relative mx-auto w-full max-w-3xl px-4 pt-2 pb-3">
          <Notices notices={notices} onDismiss={dismissNotice} />
          <Composer
            footer={
              <>
                <PromptInputButton
                  onClick={() => startInput("/")}
                  tooltip={{ content: "Commands", shortcut: "/" }}
                >
                  <SlashIcon className="size-4" />
                </PromptInputButton>
                <PromptInputButton
                  onClick={() => startInput("# ")}
                  tooltip={{ content: "Remember a fact", shortcut: "#" }}
                >
                  <HashIcon className="size-4" />
                </PromptInputButton>
                <PromptInputButton
                  onClick={() => {
                    setPaletteMode("root");
                    setPaletteOpen(true);
                  }}
                  tooltip={{ content: "Command palette", shortcut: formatKeys(["mod", "K"], mac) }}
                >
                  <CommandIcon className="size-4" />
                </PromptInputButton>
              </>
            }
            history={promptHistory}
            onChange={setInput}
            onEscape={interrupt}
            onShowShortcuts={() => setShortcutsOpen(true)}
            onStop={() => void stop()}
            onSubmit={submitComposer}
            onUnqueue={(index) => setQueue((prev) => prev.filter((_, i) => i !== index))}
            placeholder={
              !configured
                ? "Add your API keys to get started…"
                : busy
                  ? "Type to queue a message — esc to interrupt"
                  : "Ask anything — / for commands, # to remember"
            }
            queued={queue}
            status={status}
            textareaRef={textareaRef}
            value={input}
          />
          <StatusLine
            approval={pendingApproval?.mode ?? null}
            busy={busy}
            compacting={compacting}
            context={contextInfo}
            mac={mac}
            memoryCount={memories.length}
            model={keys?.llmModel ?? ""}
            onCompact={() => void compactChat()}
            onMemory={() => setMemoryOpen(true)}
            onModel={openModelPicker}
            onShortcuts={() => setShortcutsOpen(true)}
            queued={queue.length}
          />
        </div>
      </div>

      <CommandPalette
        actions={paletteActions}
        chats={chats}
        currentModel={keys?.llmModel ?? ""}
        mac={mac}
        mode={paletteMode}
        modelGroupLabel={`Models · ${provider?.label ?? "provider"}`}
        models={paletteModels}
        onModeChange={setPaletteMode}
        onOpenChange={(open) => {
          setPaletteOpen(open);
          if (!open) setPaletteMode("root");
        }}
        onOpenChat={openChat}
        onPickModel={(model) => void pickModel(model)}
        open={paletteOpen}
      />
      <ShortcutsDialog mac={mac} onOpenChange={setShortcutsOpen} open={shortcutsOpen} />
      <MemoryDialog
        memories={memories}
        onAdd={(content) => addMemory(content, { quiet: true })}
        onDelete={forgetMemory}
        onOpenChange={setMemoryOpen}
        onUpdate={updateMemory}
        open={memoryOpen}
      />
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
