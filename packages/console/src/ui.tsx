import { useEffect, useState, type ReactNode } from "react";

export function useToast(): { message: string | null; show: (message: string) => void } {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 2600);
    return () => clearTimeout(timer);
  }, [message]);
  return { message, show: setMessage };
}

export function Toast({ message }: { message: string | null }) {
  return (
    <div className={`toast${message ? " show" : ""}`} role="status">
      {message}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === "ACTIVE"
      ? "good"
      : status === "GRACE"
        ? "warn"
        : status === "UNPAID"
          ? "warn"
          : "bad";
  const label = status.replace("_", " ").toLowerCase();
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="status-row muted">
      <div className="spinner" />
      {label}
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div className="error-text">{children}</div>;
}
