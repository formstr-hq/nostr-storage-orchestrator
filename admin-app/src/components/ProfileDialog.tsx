import { useState, type FormEvent } from "react";

import controls from "../styles/controls.module.css";
import { cx } from "../lib/cx";
import { DEFAULT_HOST, type HostProfile } from "../hooks/useProfiles";
import type { BusyKind } from "../platform/types";
import { Dialog, dialogStyles } from "./Dialog";
import styles from "./ProfileDialog.module.css";

/**
 * How the operator supplies the key for a new profile.
 *
 * All three end in the same place — a stored NIP-49 `ncryptsec` — but only
 * `nsec` and `create` produce a credential the operator has not seen before and
 * therefore must back up.
 */
export type ProfileMode = "ncryptsec" | "nsec" | "create";

export type ProfileSubmission =
  | { mode: "ncryptsec"; name: string; url: string; ncryptsec: string; passphrase: string }
  | { mode: "nsec"; name: string; url: string; nsec: string; passphrase: string }
  | { mode: "create"; name: string; url: string; passphrase: string };

const MODES: Array<{ id: ProfileMode; label: string }> = [
  { id: "ncryptsec", label: "Import ncryptsec" },
  { id: "nsec", label: "Import nsec" },
  { id: "create", label: "Create new key" },
];

interface Props {
  profiles: HostProfile[];
  busy: BusyKind | null;
  onSubmit: (submission: ProfileSubmission) => void;
  onSelect: (id: string) => void;
  onBackup: (profile: HostProfile) => void;
  onDelete: (profile: HostProfile) => void;
  onClose: (() => void) | undefined;
  onValidationError: (message: string) => void;
}

export function ProfileDialog({
  profiles,
  busy,
  onSubmit,
  onSelect,
  onBackup,
  onDelete,
  onClose,
  onValidationError,
}: Props) {
  const [mode, setMode] = useState<ProfileMode>("ncryptsec");
  const [name, setName] = useState(profiles.length ? "" : "Staging");
  const [url, setUrl] = useState(DEFAULT_HOST);
  const [ncryptsec, setNcryptsec] = useState("");
  const [nsec, setNsec] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const disabled = busy !== null;
  // A brand new passphrase is being chosen, so it must be typed twice.
  const needsConfirmation = mode === "nsec" || mode === "create";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (needsConfirmation && passphrase !== confirmation) {
      onValidationError("Passphrase confirmation does not match");
      return;
    }

    const base = { name: name.trim(), url, passphrase };
    if (mode === "ncryptsec") {
      onSubmit({ mode, ...base, ncryptsec: ncryptsec.trim() });
    } else if (mode === "nsec") {
      onSubmit({ mode, ...base, nsec: nsec.trim() });
    } else {
      onSubmit({ mode, ...base });
    }

    // Secrets live in this form only until they are handed to Rust.
    setNcryptsec("");
    setNsec("");
    setPassphrase("");
    setConfirmation("");
  }

  function switchMode(next: ProfileMode) {
    setMode(next);
    setNcryptsec("");
    setNsec("");
    setPassphrase("");
    setConfirmation("");
  }

  const submitLabel =
    mode === "create"
      ? "Create and unlock"
      : mode === "nsec"
        ? "Encrypt and unlock"
        : "Import and unlock";

  return (
    <Dialog labelledBy="profile-title" onClose={onClose}>
      <div className={dialogStyles.heading}>
        <div>
          <p className={controls.eyebrow}>Host profiles</p>
          <h2 id="profile-title">Connect a control plane</h2>
        </div>
        {onClose && (
          <button
            className={dialogStyles.close}
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>

      {profiles.length > 0 && (
        <div className={styles.saved}>
          <p className={controls.eyebrow}>Saved profiles</p>
          {profiles.map((profile) => (
            <div className={styles.savedRow} key={profile.id}>
              <button
                className={styles.select}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(profile.id)}
              >
                <strong>{profile.name}</strong>
                <span>{profile.url}</span>
              </button>
              <button
                className={controls.textButton}
                type="button"
                disabled={disabled}
                onClick={() => onBackup(profile)}
              >
                Backup
              </button>
              <button
                className={cx(controls.textButton, controls.danger, styles.danger)}
                type="button"
                disabled={disabled}
                onClick={() => onDelete(profile)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={styles.modeSwitch} role="group" aria-label="Credential source">
        {MODES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={cx(mode === id && styles.active)}
            aria-pressed={mode === id}
            disabled={disabled}
            onClick={() => switchMode(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <form className={styles.form} onSubmit={submit}>
        <div className={styles.fields}>
          <label>
            Profile name
            <input
              maxLength={48}
              autoComplete="off"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Host URL
            <input
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
        </div>

        {mode === "ncryptsec" && (
          <>
            <label>
              Encrypted secret key
              <textarea
                rows={3}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="ncryptsec1..."
                required
                value={ncryptsec}
                onChange={(event) => setNcryptsec(event.target.value)}
              />
            </label>
            <label>
              Passphrase
              <input
                type="password"
                autoComplete="current-password"
                required
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </label>
          </>
        )}

        {mode === "nsec" && (
          <>
            <div className={styles.note}>
              <strong>Your nsec is encrypted in Rust and then discarded.</strong>
              <span>
                Only the resulting ncryptsec is stored. Back it up and remember
                this passphrase — you will unlock with them from now on.
              </span>
            </div>
            <label>
              Secret key
              <textarea
                rows={2}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="nsec1..."
                required
                value={nsec}
                onChange={(event) => setNsec(event.target.value)}
              />
            </label>
          </>
        )}

        {mode === "create" && (
          <div className={styles.note}>
            <strong>A new Nostr key will be generated in Rust.</strong>
            <span>
              You must back up the resulting ncryptsec and remember this
              passphrase.
            </span>
          </div>
        )}

        {needsConfirmation && (
          <div className={styles.fields}>
            <label>
              New passphrase
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </label>
            <label>
              Confirm passphrase
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
          </div>
        )}

        <button className={controls.primary} type="submit" disabled={disabled}>
          {busy === "profile" ? (
            <>
              <span className={controls.spinner} /> Securing profile
            </>
          ) : (
            submitLabel
          )}
        </button>
      </form>
    </Dialog>
  );
}
