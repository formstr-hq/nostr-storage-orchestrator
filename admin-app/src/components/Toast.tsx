import { cx } from "../lib/cx";
import type { Notice } from "../hooks/useToast";
import styles from "./Toast.module.css";

export function Toast({ notice }: { notice: Notice }) {
  return (
    <div
      className={cx(styles.toast, notice.type === "error" && styles.error)}
      role="status"
      aria-live="polite"
    >
      <span />
      {notice.message}
    </div>
  );
}
