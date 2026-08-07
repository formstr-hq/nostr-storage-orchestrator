import { useState } from "react";

import { client } from "#platform";
import { Dashboard } from "./components/Dashboard";
import { LockedPanel } from "./components/LockedPanel";
import {
  ProfileDialog,
  type ProfileSubmission,
} from "./components/ProfileDialog";
import { SecretDialog, type SecretKind } from "./components/SecretDialog";
import { Toast } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { messageOf, useSession } from "./hooks/useSession";
import { useProfiles, type HostProfile } from "./hooks/useProfiles";
import { useToast } from "./hooks/useToast";
import styles from "./App.module.css";

type DialogState =
  | { kind: "profile" }
  | { kind: SecretKind; secret: string; npub?: string }
  | null;

export function App() {
  const toast = useToast();
  const profiles = useProfiles();
  const session = useSession(toast);
  const [dialog, setDialog] = useState<DialogState>(
    profiles.profiles.length ? null : { kind: "profile" },
  );

  const selected = profiles.selected;

  async function unlockSelected(passphrase: string) {
    if (!selected) return;
    const npub = await session.unlock({
      hostUrl: selected.url,
      ncryptsec: selected.ncryptsec,
      passphrase,
    });
    // Record the npub the host will actually see, so the backup dialog can
    // show which key to add to the allowlist.
    if (npub) profiles.update(selected.id, { npub });
  }

  async function lock() {
    await session.lock();
    setDialog(null);
  }

  /**
   * Create the profile's credential if needed, unlock it, and persist it.
   *
   * Only an `ncryptsec` is ever stored: `nsec` and `create` both go through
   * Rust first, and the plaintext `nsec` is discarded there.
   */
  async function saveProfile(submission: ProfileSubmission) {
    try {
      const url = await client.normalizeHostUrl(submission.url);

      let ncryptsec: string;
      let generated: { ncryptsec: string; npub: string } | null = null;
      if (submission.mode === "ncryptsec") {
        ncryptsec = submission.ncryptsec;
      } else {
        generated =
          submission.mode === "nsec"
            ? await client.importNsec(submission.nsec, submission.passphrase)
            : await client.generateHostKey(submission.passphrase);
        ncryptsec = generated.ncryptsec;
      }

      const npub = await session.unlock(
        { hostUrl: url, ncryptsec, passphrase: submission.passphrase },
        "profile",
      );
      if (!npub) return;

      profiles.add({ name: submission.name, url, ncryptsec, npub });

      if (generated) {
        // The operator has never seen this credential; they cannot unlock
        // again without it.
        setDialog({ kind: "backup", secret: generated.ncryptsec, npub });
      } else {
        setDialog(null);
        toast.show("success", `Profile ${submission.name} imported and unlocked`);
      }
    } catch (error) {
      toast.show("error", messageOf(error));
    }
  }

  async function switchProfile(id: string) {
    await session.lock();
    profiles.select(id);
    setDialog(null);
  }

  async function deleteProfile(profile: HostProfile) {
    const confirmed = window.confirm(
      `Delete ${profile.name}? Ensure its ncryptsec is backed up first.`,
    );
    if (!confirmed) return;
    if (profile.id === profiles.selected?.id) await session.lock();
    profiles.remove(profile.id);
  }

  async function createInvite() {
    const invite = await session.createInvite();
    if (invite) setDialog({ kind: "invite", secret: invite });
  }

  async function removeDevice(npub: string) {
    const confirmed = window.confirm(
      `Remove this storage client from the mesh?\n\n${npub}\n\nIt will lose access until re-invited.`,
    );
    if (!confirmed) return;
    await session.removeDevice(npub);
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.show("success", "Copied to clipboard");
    } catch {
      toast.show("error", "Clipboard access was unavailable");
    }
  }

  return (
    <>
      <div className={styles.shell}>
        <TopBar
          profile={selected}
          unlocked={session.unlocked}
          onOpenProfiles={() => setDialog({ kind: "profile" })}
          onLock={() => void lock()}
        />

        {session.unlocked ? (
          <Dashboard
            status={session.status}
            busy={session.busy}
            onRefresh={() => void session.refresh()}
            onGenerateInvite={() => void createInvite()}
            onApproveDevice={session.approveDevice}
            onRemoveDevice={(npub) => void removeDevice(npub)}
            onCopy={(value) => void copy(value)}
          />
        ) : (
          <LockedPanel
            hasProfile={selected !== null}
            busy={session.busy}
            onUnlock={(passphrase) => void unlockSelected(passphrase)}
            onAddProfile={() => setDialog({ kind: "profile" })}
          />
        )}

        <footer className={styles.footer}>
          <span>NIP-49 encrypted at rest</span>
          <span>NIP-98 signed per request</span>
          <span>Keys in memory only</span>
        </footer>
      </div>

      {dialog?.kind === "profile" && (
        <ProfileDialog
          profiles={profiles.profiles}
          busy={session.busy}
          onSubmit={(submission) => void saveProfile(submission)}
          onSelect={(id) => void switchProfile(id)}
          onBackup={(profile) =>
            setDialog({
              kind: "backup",
              secret: profile.ncryptsec,
              ...(profile.npub ? { npub: profile.npub } : {}),
            })
          }
          onDelete={(profile) => void deleteProfile(profile)}
          // The dialog cannot be dismissed until at least one profile exists.
          onClose={profiles.profiles.length ? () => setDialog(null) : undefined}
          onValidationError={(message) => toast.show("error", message)}
        />
      )}

      {(dialog?.kind === "invite" || dialog?.kind === "backup") && (
        <SecretDialog
          kind={dialog.kind}
          secret={dialog.secret}
          npub={dialog.npub}
          onCopy={(value) => void copy(value)}
          onClose={() =>
            setDialog(profiles.profiles.length ? null : { kind: "profile" })
          }
        />
      )}

      {toast.notice && <Toast notice={toast.notice} />}
    </>
  );
}
