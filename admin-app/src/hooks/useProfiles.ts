/**
 * Host profiles, persisted in `localStorage`.
 *
 * The storage keys and record shape are unchanged from the pre-React build, so
 * an existing install keeps its profiles across the upgrade.
 *
 * The only credential ever written here is the NIP-49 `ncryptsec`. A plaintext
 * `nsec` may be typed into the import form, but Rust converts it to an
 * `ncryptsec` before it reaches this module.
 */
import { useCallback, useMemo, useState } from "react";

const STORAGE_KEY = "formstr.storage-admin.profiles.v1";
const SELECTED_KEY = "formstr.storage-admin.selected.v1";

export const DEFAULT_HOST = "https://storage.stg.formstr.app";

export interface HostProfile {
  id: string;
  name: string;
  url: string;
  ncryptsec: string;
  npub?: string;
}

function isProfile(value: unknown): value is HostProfile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<HostProfile>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.ncryptsec === "string" &&
    candidate.ncryptsec.startsWith("ncryptsec1")
  );
}

function loadProfiles(): HostProfile[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(isProfile) : [];
  } catch {
    return [];
  }
}

function persist(profiles: HostProfile[], selectedId: string | null): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId);
  else localStorage.removeItem(SELECTED_KEY);
}

export interface ProfileStore {
  profiles: HostProfile[];
  selected: HostProfile | null;
  add(profile: Omit<HostProfile, "id">): HostProfile;
  update(id: string, changes: Partial<Omit<HostProfile, "id">>): void;
  remove(id: string): void;
  select(id: string): void;
}

export function useProfiles(): ProfileStore {
  const [profiles, setProfiles] = useState<HostProfile[]>(loadProfiles);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const stored = localStorage.getItem(SELECTED_KEY);
    const initial = loadProfiles();
    const exists = initial.some((profile) => profile.id === stored);
    return exists ? stored : (initial[0]?.id ?? null);
  });

  /** Write through on every mutation so a crash cannot lose a new profile. */
  const commit = useCallback((next: HostProfile[], nextSelected: string | null) => {
    persist(next, nextSelected);
    setProfiles(next);
    setSelectedId(nextSelected);
  }, []);

  const add = useCallback<ProfileStore["add"]>(
    (profile) => {
      const created: HostProfile = { ...profile, id: crypto.randomUUID() };
      commit([...loadProfiles(), created], created.id);
      return created;
    },
    [commit],
  );

  const update = useCallback<ProfileStore["update"]>(
    (id, changes) => {
      const next = loadProfiles().map((profile) =>
        profile.id === id ? { ...profile, ...changes } : profile,
      );
      commit(next, localStorage.getItem(SELECTED_KEY));
    },
    [commit],
  );

  const remove = useCallback<ProfileStore["remove"]>(
    (id) => {
      const next = loadProfiles().filter((profile) => profile.id !== id);
      const stored = localStorage.getItem(SELECTED_KEY);
      const nextSelected = stored === id ? (next[0]?.id ?? null) : stored;
      commit(next, nextSelected);
    },
    [commit],
  );

  const select = useCallback<ProfileStore["select"]>(
    (id) => {
      const next = loadProfiles();
      if (!next.some((profile) => profile.id === id)) return;
      commit(next, id);
    },
    [commit],
  );

  const selected = useMemo(
    () => profiles.find((profile) => profile.id === selectedId) ?? null,
    [profiles, selectedId],
  );

  return { profiles, selected, add, update, remove, select };
}
