/**
 * The unlocked-host session: what the UI is allowed to do, and whether it is
 * mid-flight doing it.
 *
 * Every operation delegates to the platform `AdminClient`, so this hook holds
 * no key material and makes no security decisions — it only tracks which
 * operation is in progress and turns rejections into toasts.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { client } from "#platform";
import type { BusyKind, HostStatus, UnlockInput } from "../platform/types";
import type { ToastStore } from "./useToast";

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "The operation could not be completed";
}

export interface SessionStore {
  unlocked: boolean;
  status: HostStatus | null;
  busy: BusyKind | null;
  /** Unlock a host. Resolves to the operator npub, or `null` on failure. */
  unlock(input: UnlockInput, kind?: BusyKind): Promise<string | null>;
  lock(): Promise<void>;
  refresh(options?: { silent?: boolean }): Promise<void>;
  createInvite(): Promise<string | null>;
  approveDevice(npub: string): Promise<boolean>;
  removeDevice(npub: string): Promise<boolean>;
}

export function useSession(toast: ToastStore): SessionStore {
  const [unlocked, setUnlocked] = useState(false);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [busy, setBusy] = useState<BusyKind | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const lock = useCallback(async () => {
    try {
      await client.lockHost();
    } finally {
      // The UI must show "locked" even if the platform call failed, so the
      // operator is never told a key is protected when it might not be.
      setUnlocked(false);
      setStatus(null);
    }
  }, []);

  const refresh = useCallback<SessionStore["refresh"]>(
    async ({ silent = false } = {}) => {
      if (!silent) setBusy("status");
      try {
        const next = await client.status();
        if (mounted.current) setStatus(next);
      } catch (error) {
        toast.show("error", messageOf(error));
      } finally {
        if (!silent && mounted.current) setBusy(null);
      }
    },
    [toast],
  );

  const unlock = useCallback<SessionStore["unlock"]>(
    async (input, kind = "unlock") => {
      setBusy(kind);
      toast.clear();
      try {
        const result = await client.unlockHost(input);
        setUnlocked(true);
        setStatus(null);
        void refresh({ silent: true });
        return result.npub;
      } catch (error) {
        toast.show("error", messageOf(error));
        return null;
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [refresh, toast],
  );

  const createInvite = useCallback<SessionStore["createInvite"]>(async () => {
    setBusy("invite");
    try {
      return await client.generateInvite();
    } catch (error) {
      toast.show("error", messageOf(error));
      return null;
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [toast]);

  const approveDevice = useCallback<SessionStore["approveDevice"]>(
    async (npub) => {
      setBusy("device");
      try {
        await client.addDevice(npub);
        toast.show(
          "success",
          "Device approved. Roster synchronization may take a moment.",
        );
        void refresh({ silent: true });
        return true;
      } catch (error) {
        toast.show("error", messageOf(error));
        return false;
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [refresh, toast],
  );

  const removeDevice = useCallback<SessionStore["removeDevice"]>(
    async (npub) => {
      setBusy("device-remove");
      try {
        await client.removeDevice(npub);
        toast.show(
          "success",
          "Device removed. Roster synchronization may take a moment.",
        );
        void refresh({ silent: true });
        return true;
      } catch (error) {
        toast.show("error", messageOf(error));
        return false;
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [refresh, toast],
  );

  // Leaving the page must not leave a decrypted key behind in the host process.
  useEffect(() => {
    const onHide = () => void client.lockHost().catch(() => {});
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  return {
    unlocked,
    status,
    busy,
    unlock,
    lock,
    refresh,
    createInvite,
    approveDevice,
    removeDevice,
  };
}

export { messageOf };
