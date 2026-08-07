import { useCallback, useEffect, useRef, useState } from "react";

const VISIBLE_MS = 4200;

export interface Notice {
  type: "error" | "success";
  message: string;
}

export interface ToastStore {
  notice: Notice | null;
  show(type: Notice["type"], message: string): void;
  clear(): void;
}

export function useToast(): ToastStore {
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setNotice(null);
  }, []);

  const show = useCallback<ToastStore["show"]>((type, message) => {
    if (timer.current !== null) clearTimeout(timer.current);
    setNotice({ type, message });
    // A later notice always wins; the timer belongs to whichever is showing.
    timer.current = setTimeout(() => {
      timer.current = null;
      setNotice(null);
    }, VISIBLE_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return { notice, show, clear };
}
