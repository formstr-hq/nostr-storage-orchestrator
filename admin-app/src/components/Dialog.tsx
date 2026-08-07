import { useEffect, useRef, type ReactNode } from "react";

import { cx } from "../lib/cx";
import styles from "./Dialog.module.css";

interface Props {
  labelledBy: string;
  className?: string | undefined;
  /** Omitted when the dialog must not be dismissed (no profile exists yet). */
  onClose?: (() => void) | undefined;
  children: ReactNode;
}

export function Dialog({ labelledBy, className, onClose, children }: Props) {
  const panel = useRef<HTMLElement>(null);

  // Focus moves into the dialog so keyboard and screen reader users are not
  // left behind on the page underneath. Deliberately mount-only: `onClose` is
  // usually a fresh closure each render, and re-running this would pull focus
  // back out of whatever field the operator is typing in.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (onClose && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panel}
        className={cx(styles.dialog, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}

export { styles as dialogStyles };
