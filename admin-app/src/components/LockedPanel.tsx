import { useState, type FormEvent } from "react";

import controls from "../styles/controls.module.css";
import { cx } from "../lib/cx";
import type { BusyKind } from "../platform/types";
import styles from "./LockedPanel.module.css";

interface Props {
  hasProfile: boolean;
  busy: BusyKind | null;
  onUnlock: (passphrase: string) => void;
  onAddProfile: () => void;
}

export function LockedPanel({ hasProfile, busy, onUnlock, onAddProfile }: Props) {
  const [passphrase, setPassphrase] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    onUnlock(passphrase);
    // Drop the passphrase from component state the moment it is handed off.
    setPassphrase("");
  }

  return (
    <section className={styles.panel}>
      <div className={styles.mark}>
        <span />
      </div>
      <p className={controls.eyebrow}>Session locked</p>
      <h1>Unlock the control plane.</h1>
      <p className={styles.lede}>
        Your passphrase is sent directly to Rust for this unlock only. It is
        never stored.
      </p>

      {hasProfile ? (
        <form className={styles.form} onSubmit={submit}>
          <label>
            Passphrase
            <input
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
          <button className={controls.primary} type="submit" disabled={busy !== null}>
            {busy === "unlock" ? (
              <>
                <span className={controls.spinner} /> Unlocking
              </>
            ) : (
              "Unlock host"
            )}
          </button>
        </form>
      ) : (
        <button
          className={cx(controls.primary)}
          type="button"
          onClick={onAddProfile}
        >
          Add host profile
        </button>
      )}
    </section>
  );
}
