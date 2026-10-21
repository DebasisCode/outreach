"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  KeySquareIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  UserIcon,
  UserRoundCogIcon,
} from "lucide-react";
import { useState } from "react";
import { LLM_PROVIDERS, type UserKeys } from "@/lib/types";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keys: UserKeys;
  username: string | null;
  /** Save keys (under the current username, or a new one typed below). */
  onSave: (username: string, keys: UserKeys) => Promise<void>;
  /** Switch to an existing profile. */
  onSwitch: (username: string) => Promise<void>;
}

function SettingsDialogForm({
  keys,
  username,
  onClose,
  onSave,
  onSwitch,
}: {
  keys: UserKeys;
  username: string | null;
  onClose: () => void;
  onSave: (username: string, keys: UserKeys) => Promise<void>;
  onSwitch: (username: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<UserKeys>(keys);
  const [name, setName] = useState(username ?? "");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isOllama = draft.llmProvider === "ollama";

  const loadOllamaModels = async (apiKey: string) => {
    if (!apiKey.trim()) {
      setOllamaError("Enter your Ollama API key first.");
      return;
    }
    setOllamaLoading(true);
    setOllamaError(null);
    try {
      const res = await fetch("/api/ollama/models", {
        headers: { "x-ollama-key": apiKey },
      });
      const data = (await res.json()) as {
        models?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to list models");
      setOllamaModels(data.models ?? []);
      if (data.models?.length && !data.models.includes(draft.llmModel)) {
        setDraft((prev) => ({ ...prev, llmModel: data.models![0] }));
      }
    } catch (err) {
      setOllamaError(err instanceof Error ? err.message : "Failed to list models");
      setOllamaModels([]);
    } finally {
      setOllamaLoading(false);
    }
  };

  const save = async () => {
    if (!name.trim()) {
      setFormError("Pick a username to save your keys under.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await onSave(name.trim(), draft);
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  const switchTo = async () => {
    if (!name.trim()) {
      setFormError("Type the username to switch to.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await onSwitch(name.trim());
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to switch");
    } finally {
      setBusy(false);
    }
  };

  const providerConfig = LLM_PROVIDERS.find(
    (p) => p.id === draft.llmProvider,
  );

  return (
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <KeySquareIcon className="size-4" /> API keys & profile
        </DialogTitle>
        <DialogDescription>
          Keys are stored in the local SQLite database under your username —
          one line, nothing leaves this machine except vendor API calls.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-5 py-2">
        {/* Account */}
        <div className="grid gap-2">
          <Label htmlFor="username" className="flex items-center gap-1.5">
            <UserIcon className="size-3.5" /> Username
          </Label>
          <div className="flex gap-2">
            <Input
              autoCapitalize="none"
              autoComplete="off"
              id="username"
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. debol"
              value={name}
            />
            <Button disabled={busy || !name.trim()} onClick={() => void switchTo()} size="sm" variant="outline">
              <UserRoundCogIcon className="size-4" />
              Load
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            New name = new profile on first save; existing name + Load pulls
            its stored keys.
          </p>
        </div>

        {/* LLM */}
        <div className="grid gap-2">
          <Label>LLM provider</Label>
          <Select
            value={draft.llmProvider}
            onValueChange={(value: UserKeys["llmProvider"]) => {
              const provider = LLM_PROVIDERS.find((p) => p.id === value);
              if (!provider) return;
              setDraft({
                ...draft,
                llmProvider: value,
                llmModel: provider.defaultModel,
              });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Provider" />
            </SelectTrigger>
            <SelectContent>
              {LLM_PROVIDERS.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="llm-api-key">{providerConfig?.label} API key</Label>
          <Input
            autoComplete="off"
            id="llm-api-key"
            onChange={(event) =>
              setDraft({ ...draft, llmApiKey: event.target.value })
            }
            placeholder={providerConfig?.keyHint ?? "sk-..."}
            type="password"
            value={draft.llmApiKey}
          />
          {isOllama ? (
            <p className="text-muted-foreground text-xs">
              Create a key at ollama.com/settings/keys — billed as pay-as-you-go
              usage credits.
            </p>
          ) : null}
        </div>

        <div className="grid gap-2">
          <Label>Model</Label>
          {isOllama ? (
            <>
              <div className="flex gap-2">
                <Select
                  disabled={ollamaModels.length === 0}
                  value={draft.llmModel}
                  onValueChange={(value) =>
                    setDraft({ ...draft, llmModel: value })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={
                        ollamaModels.length === 0
                          ? "Load models to pick one"
                          : "Model"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {ollamaModels.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  disabled={ollamaLoading}
                  onClick={() => void loadOllamaModels(draft.llmApiKey)}
                  size="icon"
                  title="List my Ollama Cloud models"
                  variant="outline"
                >
                  {ollamaLoading ? (
                    <LoaderCircleIcon className="animate-spin" />
                  ) : (
                    <RefreshCwIcon />
                  )}
                </Button>
              </div>
              {ollamaError ? (
                <p className="text-destructive text-xs">{ollamaError}</p>
              ) : null}
            </>
          ) : (
            <Select
              value={draft.llmModel}
              onValueChange={(value) => setDraft({ ...draft, llmModel: value })}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent>
                {(providerConfig?.models ?? []).map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* CleanList */}
        <div className="grid gap-2">
          <Label htmlFor="cleanlist-key">CleanList API key</Label>
          <Input
            autoComplete="off"
            id="cleanlist-key"
            onChange={(event) =>
              setDraft({ ...draft, cleanlistApiKey: event.target.value })
            }
            placeholder="clapi_..."
            type="password"
            value={draft.cleanlistApiKey}
          />
          <p className="text-muted-foreground text-xs">
            Powers people search (free) and email enrichment (1 credit per
            person).
          </p>
        </div>

        {/* Composio */}
        <div className="grid gap-2">
          <Label htmlFor="composio-key">Composio API key</Label>
          <Input
            autoComplete="off"
            id="composio-key"
            onChange={(event) =>
              setDraft({ ...draft, composioApiKey: event.target.value })
            }
            placeholder="Composio key"
            type="password"
            value={draft.composioApiKey}
          />
          <p className="text-muted-foreground text-xs">
            Powers job search and sending email from your own Gmail/Outlook —
            connect them with the plug icon after saving.
          </p>
        </div>

        {formError ? <p className="text-destructive text-sm">{formError}</p> : null}
      </div>

      <DialogFooter>
        <Button disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
          Save keys
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  keys,
  username,
  onSave,
  onSwitch,
}: SettingsDialogProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {open ? (
        <SettingsDialogForm
          keys={keys}
          onClose={() => onOpenChange(false)}
          onSwitch={onSwitch}
          onSave={onSave}
          username={username}
        />
      ) : null}
    </Dialog>
  );
}