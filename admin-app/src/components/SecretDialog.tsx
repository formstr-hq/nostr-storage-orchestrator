import controls from "../styles/controls.module.css";
import { cx } from "../lib/cx";
import { Dialog } from "./Dialog";
import styles from "./SecretDialog.module.css";

export type SecretKind = "invite" | "backup";

interface Props {
  kind: SecretKind;
  secret: string;
  /** Shown for backups so the operator can add themselves to the allowlist. */
  npub?: string | undefined;
  onCopy: (value: string) => void;
  onClose: () => void;
}

const COPY = {
  invite: {
    eyebrow: "Bearer credential",
    title: "Share this invite securely.",
    body: "Anyone holding this reusable host invite can request enrollment until the host rotates it. Send it through a secure channel.",
    action: "Copy invite",
  },
  backup: {
    eyebrow: "Encrypted key backup",
    title: "Store this ncryptsec safely.",
    body: "This encrypted credential is recoverable only with its passphrase. The passphrase is not stored by this app.",
    action: "Copy ncryptsec",
  },
} as const;

export function SecretDialog({ kind, secret, npub, onCopy, onClose }: Props) {
  const copy = COPY[kind];

  return (
    <Dialog labelledBy="secret-title" className={styles.secret} onClose={onClose}>
      <div className={styles.warning}>!</div>
      <p className={controls.eyebrow}>{copy.eyebrow}</p>
      <h2 id="secret-title">{copy.title}</h2>
      <p>{copy.body}</p>

      {kind === "backup" && npub && (
        <div className={styles.operatorKey}>
          <span>Operator npub / add to host allowlist</span>
          <code>{npub}</code>
          <button
            className={controls.textButton}
            type="button"
            onClick={() => onCopy(npub)}
          >
            Copy operator npub
          </button>
        </div>
      )}

      <div className={styles.value} tabIndex={0}>
        {secret}
      </div>

      <button
        className={cx(controls.primary, controls.warm, styles.copy)}
        type="button"
        onClick={() => onCopy(secret)}
      >
        {copy.action}
      </button>
      <button
        className={cx(controls.textButton, styles.dismiss)}
        type="button"
        onClick={onClose}
      >
        I have stored it safely
      </button>
    </Dialog>
  );
}
