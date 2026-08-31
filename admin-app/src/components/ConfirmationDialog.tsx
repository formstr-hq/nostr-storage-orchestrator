import type { ReactNode } from "react";

import { cx } from "../lib/cx";
import controls from "../styles/controls.module.css";
import { Dialog, dialogStyles } from "./Dialog";
import styles from "./ControlPlane.module.css";

interface Props {
  id: string;
  eyebrow: string;
  title: string;
  busy: boolean;
  action: string;
  busyAction: string;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}

export function ConfirmationDialog({
  id,
  eyebrow,
  title,
  busy,
  action,
  busyAction,
  onConfirm,
  onClose,
  children,
}: Props) {
  return (
    <Dialog labelledBy={id} onClose={busy ? undefined : onClose}>
      <div className={dialogStyles.heading}>
        <div>
          <p className={controls.eyebrow}>{eyebrow}</p>
          <h2 id={id}>{title}</h2>
        </div>
        <button className={dialogStyles.close} type="button" disabled={busy} onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>
      <div className={styles.dialogForm}>
        {children}
        <button className={cx(controls.primary, styles.fullWidth)} type="button" disabled={busy} onClick={onConfirm}>
          {busy ? <><span className={controls.spinner} /> {busyAction}</> : action}
        </button>
      </div>
    </Dialog>
  );
}
