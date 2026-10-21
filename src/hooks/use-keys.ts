"use client";

import { get, set } from "idb-keyval";
import { useCallback, useEffect, useState } from "react";
import type { UserKeys } from "@/lib/types";

const LAST_USERNAME_KEY = "outreach-last-username";

export const DEFAULT_KEYS: UserKeys = {
  llmApiKey: "",
  llmProvider: "anthropic",
  llmModel: "claude-sonnet-4-5",
  cleanlistApiKey: "",
  composioApiKey: "",
  composioUserId: "default",
};

/**
 * Keys live in the local SQLite DB keyed by a plain username (no password —
 * this is a personal/local tool). IndexedDB caches only the last username so
 * a returning user is auto-loaded.
 */
export function useKeys() {
  const [username, setUsername] = useState<string | null>(null);
  const [keys, setKeys] = useState<UserKeys | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auto-load the last username on mount.
  useEffect(() => {
    let mounted = true;
    get<string>(LAST_USERNAME_KEY)
      .then(async (stored) => {
        if (!mounted) return;
        if (stored) {
          try {
            const res = await fetch(
              `/api/profile?username=${encodeURIComponent(stored)}`,
            );
            if (res.ok) {
              const data = (await res.json()) as { keys: UserKeys };
              if (!mounted) return;
              setUsername(stored);
              setKeys({ ...DEFAULT_KEYS, ...data.keys });
              return;
            }
          } catch {
            // fall through to defaults
          }
        }
        if (mounted) setKeys({ ...DEFAULT_KEYS });
      })
      .catch(() => {
        if (mounted) setKeys({ ...DEFAULT_KEYS });
      });
    return () => {
      mounted = false;
    };
  }, []);

  /** Sign in as `name`: fetch their keys from the DB. */
  const loadUser = useCallback(async (name: string): Promise<boolean> => {
    setError(null);
    if (!name.trim()) return false;
    try {
      const res = await fetch(
        `/api/profile?username=${encodeURIComponent(name.trim())}`,
      );
      if (res.status === 404) {
        setError(`No saved keys for "${name.trim()}" yet.`);
        return false;
      }
      if (!res.ok) {
        setError("Failed to load profile.");
        return false;
      }
      const data = (await res.json()) as { keys: UserKeys };
      setUsername(name.trim().toLowerCase());
      setKeys({ ...DEFAULT_KEYS, ...data.keys });
      await set(LAST_USERNAME_KEY, name.trim().toLowerCase());
      return true;
    } catch {
      setError("Failed to load profile.");
      return false;
    }
  }, []);

  /** Save `next` keys under the current username (creates it when new). */
  const saveKeys = useCallback(
    async (next: UserKeys): Promise<boolean> => {
      if (!username) {
        setError("Pick a username first.");
        return false;
      }
      try {
        const res = await fetch("/api/profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, keys: next }),
        });
        if (!res.ok) throw new Error("Failed to save");
        setKeys(next);
        await set(LAST_USERNAME_KEY, username);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save");
        return false;
      }
    },
    [username],
  );

  /** Save under a brand-new (or different) username. */
  const saveAs = useCallback(
    async (name: string, next: UserKeys): Promise<boolean> => {
      if (!name.trim()) {
        setError("Username required.");
        return false;
      }
      try {
        const res = await fetch("/api/profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: name.trim(), keys: next }),
        });
        if (!res.ok) throw new Error("Failed to save");
        setUsername(name.trim().toLowerCase());
        setKeys(next);
        await set(LAST_USERNAME_KEY, name.trim().toLowerCase());
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save");
        return false;
      }
    },
    [],
  );

  const switchUser = useCallback(async (name: string): Promise<boolean> => {
    return loadUser(name);
  }, [loadUser]);

  return {
    username,
    keys,
    saveKeys,
    saveAs,
    switchUser,
    error,
    ready: keys !== null,
  };
}