/** Role-aware state for the currently unlocked host. */
import { useCallback, useEffect, useRef, useState } from "react";

import { client } from "#platform";
import type {
  BusyKind,
  HostStatus,
  Me,
  Member,
  MemberRole,
  Roster,
  Storage,
  UnlockInput,
} from "../platform/types";
import type { ToastStore } from "./useToast";

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "The operation could not be completed";
}

export interface SessionStore {
  unlocked: boolean;
  me: Me | null;
  status: HostStatus | null;
  roster: Roster | null;
  members: Member[];
  storages: Storage[];
  busy: BusyKind | null;
  unlock(input: UnlockInput, kind?: BusyKind): Promise<string | null>;
  lock(): Promise<void>;
  refresh(options?: { silent?: boolean }): Promise<void>;
  createInvite(): Promise<string | null>;
  authorizeMember(npub: string, role: MemberRole): Promise<boolean>;
  revokeMember(npub: string): Promise<boolean>;
  linkStorage(npub: string): Promise<boolean>;
  setStorageCapacity(npub: string, bytes: string): Promise<boolean>;
  removeStorage(npub: string): Promise<boolean>;
}

export function useSession(toast: ToastStore): SessionStore {
  const [unlocked, setUnlocked] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [storages, setStorages] = useState<Storage[]>([]);
  const [busy, setBusy] = useState<BusyKind | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const clearData = useCallback(() => {
    setMe(null);
    setStatus(null);
    setRoster(null);
    setMembers([]);
    setStorages([]);
  }, []);

  const lock = useCallback(async () => {
    generation.current += 1;
    try {
      await client.lockHost();
    } finally {
      setUnlocked(false);
      setBusy(null);
      clearData();
    }
  }, [clearData]);

  const refresh = useCallback<SessionStore["refresh"]>(
    async ({ silent = false } = {}) => {
      const started = generation.current;
      if (!silent) setBusy("refresh");
      try {
        const nextMe = await client.me();
        if (!mounted.current || generation.current !== started) return;
        setMe(nextMe);

        if (nextMe.role === "none") {
          setStatus(null);
          setRoster(null);
          setMembers([]);
          setStorages([]);
          return;
        }

        if (nextMe.role === "client") {
          const nextStorages = await client.storages();
          if (!mounted.current || generation.current !== started) return;
          setStatus(null);
          setRoster(null);
          setMembers([]);
          setStorages(nextStorages);
          return;
        }

        const [nextStatus, nextRoster, nextMembers, nextStorages] =
          await Promise.all([
            client.status(),
            client.roster(),
            client.members(),
            client.storages(),
          ]);
        if (!mounted.current || generation.current !== started) return;
        setStatus(nextStatus);
        setRoster(nextRoster);
        setMembers(nextMembers);
        setStorages(nextStorages);
      } catch (error) {
        if (mounted.current && generation.current === started) {
          toast.show("error", messageOf(error));
        }
      } finally {
        if (!silent && mounted.current && generation.current === started) {
          setBusy(null);
        }
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
        generation.current += 1;
        clearData();
        setUnlocked(true);
        await refresh({ silent: true });
        return result.npub;
      } catch (error) {
        toast.show("error", messageOf(error));
        return null;
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [clearData, refresh, toast],
  );

  const mutate = useCallback(
    async (
      kind: BusyKind,
      operation: () => Promise<void>,
      success: string,
    ): Promise<boolean> => {
      const started = generation.current;
      setBusy(kind);
      try {
        await operation();
        if (!mounted.current || generation.current !== started) return false;
        toast.show("success", success);
        await refresh({ silent: true });
        return true;
      } catch (error) {
        if (mounted.current && generation.current === started) {
          toast.show("error", messageOf(error));
        }
        return false;
      } finally {
        if (mounted.current && generation.current === started) setBusy(null);
      }
    },
    [refresh, toast],
  );

  const createInvite = useCallback<SessionStore["createInvite"]>(async () => {
    const started = generation.current;
    setBusy("invite");
    try {
      return await client.generateInvite();
    } catch (error) {
      if (mounted.current && generation.current === started) {
        toast.show("error", messageOf(error));
      }
      return null;
    } finally {
      if (mounted.current && generation.current === started) setBusy(null);
    }
  }, [toast]);

  const authorizeMember = useCallback<SessionStore["authorizeMember"]>(
    (npub, role) =>
      mutate(
        "member-authorize",
        () => client.authorizeMember(npub, role),
        role === "admin" ? "Admin authorized" : "Client authorized",
      ),
    [mutate],
  );

  const revokeMember = useCallback<SessionStore["revokeMember"]>(
    (npub) =>
      mutate(
        "member-revoke",
        () => client.revokeMember(npub),
        "Member revoked and their storage removed from the mesh",
      ),
    [mutate],
  );

  const linkStorage = useCallback<SessionStore["linkStorage"]>(
    (npub) =>
      mutate(
        "storage-link",
        () => client.linkStorage(npub),
        "Storage linked to your roster",
      ),
    [mutate],
  );

  const setStorageCapacity = useCallback<SessionStore["setStorageCapacity"]>(
    (npub, bytes) =>
      mutate(
        "storage-capacity",
        () => client.setStorageCapacity(npub, bytes),
        "Declared capacity updated",
      ),
    [mutate],
  );

  const removeStorage = useCallback<SessionStore["removeStorage"]>(
    (npub) =>
      mutate(
        "storage-remove",
        () => client.removeStorage(npub),
        "Storage removed from the mesh",
      ),
    [mutate],
  );

  useEffect(() => {
    const onHide = () => void client.lockHost().catch(() => {});
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  return {
    unlocked,
    me,
    status,
    roster,
    members,
    storages,
    busy,
    unlock,
    lock,
    refresh,
    createInvite,
    authorizeMember,
    revokeMember,
    linkStorage,
    setStorageCapacity,
    removeStorage,
  };
}

export { messageOf };
