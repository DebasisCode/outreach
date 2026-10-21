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
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  FileSpreadsheetIcon,
  LinkIcon,
  LoaderCircleIcon,
  PlugIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TrackerStatus } from "@/lib/tool-outputs";
import { COMPOSIO_TOOLKITS, type ComposioToolkit } from "@/lib/types";

export interface Connection {
  id: string;
  toolkitSlug: string;
  status: string;
  createdAt: string | null;
  /** Mailbox address (Gmail/Outlook) or quota (SerpAPI) for active ones. */
  account: string | null;
}

interface ConnectionsDialogProps {
  composioApiKey: string;
  composioUserId: string;
  onOpenChange: (open: boolean) => void;
  /** Receives the latest connections after every refresh. */
  onConnectionsChange?: (connections: Connection[]) => void;
  open: boolean;
  /** The Google Sheet tracker, shown under Google Sheets. */
  tracker?: TrackerStatus | null;
  trackerSyncing?: boolean;
  onSyncTracker?: () => void;
}

const OAUTH_WAIT_MS = 3 * 60 * 1000;

/** The tracker sheet's link, sync state and a Sync now button. */
function TrackerPanel({
  tracker,
  syncing,
  onSync,
}: {
  tracker: TrackerStatus | null | undefined;
  syncing: boolean;
  onSync?: () => void;
}) {
  const waiting = tracker
    ? tracker.pending.jobs + tracker.pending.contacts + tracker.pending.emails
    : 0;
  const busy = syncing || Boolean(tracker?.syncing);
  let line: string;
  let problem = false;
  if (busy) {
    line = tracker?.url ? "Syncing…" : "Creating your Outreach Tracker sheet…";
  } else if (tracker?.lastError) {
    line = `Last sync failed: ${tracker.lastError}`;
    problem = true;
  } else if (!tracker?.url) {
    line = "Creates an “Outreach Tracker” sheet with Jobs, Contacts and Emails tabs.";
  } else if (waiting > 0) {
    line = `${waiting} change${waiting === 1 ? "" : "s"} waiting to be logged`;
  } else if (tracker.lastSyncedAt) {
    line = `Up to date · synced ${new Date(tracker.lastSyncedAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  } else {
    line = "Up to date";
  }

  return (
    <div className="mt-2 flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
      <div className="min-w-0">
        {tracker?.url ? (
          <a
            className="inline-flex items-center gap-1 text-xs font-medium hover:underline"
            href={tracker.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            <FileSpreadsheetIcon className="size-3.5 text-green-600" />
            Outreach Tracker
            <ExternalLinkIcon className="size-3 opacity-50" />
          </a>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium">
            <FileSpreadsheetIcon className="size-3.5" />
            Tracker sheet
          </span>
        )}
        <p className={`text-[11px] ${problem ? "text-destructive" : "text-muted-foreground"}`}>
          {line}
        </p>
      </div>
      <Button disabled={busy || !onSync} onClick={onSync} size="xs" variant="outline">
        {busy ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
        {tracker?.url ? "Sync now" : "Create sheet"}
      </Button>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  EXPIRED: "Expired",
  FAILED: "Failed",
  INACTIVE: "Inactive",
  REVOKED: "Revoked",
  INITIATED: "Not finished",
  INITIALIZING: "Not finished",
};

export function ConnectionsDialog({
  composioApiKey,
  composioUserId,
  onOpenChange,
  onConnectionsChange,
  open,
  tracker,
  trackerSyncing = false,
  onSyncTracker,
}: ConnectionsDialogProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Toolkit whose sign-in is open in another tab.
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const activeBeforeRef = useRef<Set<string>>(new Set());
  const onChangeRef = useRef(onConnectionsChange);

  useEffect(() => {
    onChangeRef.current = onConnectionsChange;
  }, [onConnectionsChange]);

  const refresh = useCallback(async (): Promise<Connection[] | null> => {
    if (!composioApiKey) return null;
    setLoading(true);
    try {
      const res = await fetch("/api/composio/connections", {
        headers: {
          "x-composio-key": composioApiKey,
          "x-composio-user": composioUserId,
        },
      });
      const data = (await res.json()) as { connections?: Connection[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load connections");
      const list = data.connections ?? [];
      setConnections(list);
      setError(null);
      onChangeRef.current?.(list);
      return list;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load connections");
      return null;
    } finally {
      setLoading(false);
    }
  }, [composioApiKey, composioUserId]);

  // Load whenever the dialog opens, and when the user comes back to this tab
  // (e.g. after finishing Google sign-in in the other tab).
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void refresh(), 0);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [open, refresh]);

  // While sign-in is open in another tab, poll until the new account shows up.
  useEffect(() => {
    if (!open || !waitingFor) return;
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      const list = await refresh();
      const connected = list?.some(
        (c) =>
          c.toolkitSlug === waitingFor &&
          c.status === "ACTIVE" &&
          !activeBeforeRef.current.has(c.id),
      );
      if (connected || Date.now() - startedAt > OAUTH_WAIT_MS) setWaitingFor(null);
    }, 4000);
    return () => clearInterval(timer);
  }, [open, waitingFor, refresh]);

  const connectWithSignIn = async (toolkit: ComposioToolkit) => {
    setBusyId(toolkit.slug);
    setError(null);
    // Open the tab inside the click so popup blockers allow it; point it at
    // Composio's sign-in page once the link is ready.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    try {
      const res = await fetch("/api/composio/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          composioApiKey,
          composioUserId,
          toolkitSlug: toolkit.slug,
        }),
      });
      const data = (await res.json()) as { redirectUrl?: string; error?: string };
      if (!res.ok || !data.redirectUrl) {
        throw new Error(data.error ?? "Failed to create the sign-in link");
      }
      activeBeforeRef.current = new Set(
        connections.filter((c) => c.status === "ACTIVE").map((c) => c.id),
      );
      if (tab) tab.location.href = data.redirectUrl;
      else window.open(data.redirectUrl, "_blank", "noopener,noreferrer");
      setWaitingFor(toolkit.slug);
    } catch (err) {
      tab?.close();
      setError(err instanceof Error ? err.message : "Failed to create the sign-in link");
    } finally {
      setBusyId(null);
    }
  };

  const connectWithKey = async (toolkit: ComposioToolkit) => {
    const secret = apiKeys[toolkit.slug]?.trim();
    if (!secret) {
      setError(`Paste your ${toolkit.label} API key first.`);
      return;
    }
    setBusyId(toolkit.slug);
    setError(null);
    try {
      const res = await fetch("/api/composio/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          composioApiKey,
          composioUserId,
          toolkitSlug: toolkit.slug,
          apiKey: secret,
        }),
      });
      const data = (await res.json()) as { status?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to connect");
      if (data.status && data.status !== "ACTIVE") {
        setError(`Composio saved the key, but the connection is ${data.status.toLowerCase()}.`);
      }
      setApiKeys((prev) => ({ ...prev, [toolkit.slug]: "" }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (connection: Connection) => {
    const label = connection.account ?? connection.toolkitSlug;
    if (!window.confirm(`Disconnect ${label}? You can connect it again any time.`)) return;
    setBusyId(connection.id);
    setError(null);
    try {
      const res = await fetch(
        `/api/composio/connections?id=${encodeURIComponent(connection.id)}`,
        {
          method: "DELETE",
          headers: {
            "x-composio-key": composioApiKey,
            "x-composio-user": composioUserId,
          },
        },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to disconnect");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlugIcon className="size-4" /> Connections
          </DialogTitle>
          <DialogDescription>
            Accounts the assistant can act through, managed by Composio. Emails
            are sent from your own mailbox, and only after you click Send.
            Google Sheets keeps your application tracker.
          </DialogDescription>
        </DialogHeader>

        {!composioApiKey ? (
          <p className="text-muted-foreground text-sm">
            Add your Composio API key in Settings first.
          </p>
        ) : (
          <div className="flex flex-col gap-3 py-2">
            {COMPOSIO_TOOLKITS.map((toolkit) => {
              const mine = connections.filter((c) => c.toolkitSlug === toolkit.slug);
              const active = mine.filter((c) => c.status === "ACTIVE");
              const latestStatus = mine[0]?.status;
              const problem =
                active.length === 0 && latestStatus ? STATUS_LABELS[latestStatus] : undefined;
              const busy = busyId === toolkit.slug;
              return (
                <div className="rounded-lg border p-3" key={toolkit.slug}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{toolkit.label}</span>
                        {active.length > 0 ? (
                          <Badge className="rounded-full text-[10px]" variant="secondary">
                            <CheckCircle2Icon className="size-3 text-green-600" />
                            Connected
                          </Badge>
                        ) : problem ? (
                          <Badge className="rounded-full text-[10px]" variant="outline">
                            {problem}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {toolkit.description}
                      </p>
                    </div>
                    {toolkit.connect === "oauth" ? (
                      <Button
                        disabled={busy || waitingFor === toolkit.slug}
                        onClick={() => void connectWithSignIn(toolkit)}
                        size="sm"
                        variant={active.length > 0 ? "ghost" : "outline"}
                      >
                        {busy ? <LoaderCircleIcon className="animate-spin" /> : <LinkIcon />}
                        {active.length > 0
                          ? "Add another"
                          : latestStatus === "EXPIRED"
                            ? "Reconnect"
                            : "Connect"}
                      </Button>
                    ) : null}
                  </div>

                  {active.map((connection) => (
                    <div
                      className="bg-muted/40 mt-2 flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
                      key={connection.id}
                    >
                      <span className="truncate font-mono text-xs">
                        {connection.account ??
                          (toolkit.slug === "googlesheets" ? "Google account" : "Connected account")}
                      </span>
                      <Button
                        disabled={busyId === connection.id}
                        onClick={() => void disconnect(connection)}
                        size="xs"
                        variant="ghost"
                      >
                        {busyId === connection.id ? (
                          <LoaderCircleIcon className="animate-spin" />
                        ) : null}
                        Disconnect
                      </Button>
                    </div>
                  ))}

                  {toolkit.slug === "googlesheets" && active.length > 0 ? (
                    <TrackerPanel
                      onSync={onSyncTracker}
                      syncing={trackerSyncing}
                      tracker={tracker}
                    />
                  ) : null}

                  {toolkit.connect === "api_key" && active.length === 0 ? (
                    <div className="mt-2 flex gap-2">
                      <Input
                        autoComplete="off"
                        onChange={(event) =>
                          setApiKeys((prev) => ({ ...prev, [toolkit.slug]: event.target.value }))
                        }
                        placeholder={`Paste your ${toolkit.label.split(" ")[0]} API key`}
                        type="password"
                        value={apiKeys[toolkit.slug] ?? ""}
                      />
                      <Button
                        disabled={busy}
                        onClick={() => void connectWithKey(toolkit)}
                        size="sm"
                        variant="outline"
                      >
                        {busy ? <LoaderCircleIcon className="animate-spin" /> : <LinkIcon />}
                        Connect
                      </Button>
                    </div>
                  ) : null}

                  {waitingFor === toolkit.slug ? (
                    <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
                      <LoaderCircleIcon className="size-3 animate-spin" />
                      Finish signing in on the new tab — this updates by itself.
                    </p>
                  ) : null}
                </div>
              );
            })}
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            <Button disabled={loading} onClick={() => void refresh()} size="sm" variant="ghost">
              {loading ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
              Refresh
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
