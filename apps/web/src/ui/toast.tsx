/** Toast — the app-wide, aria-live notification channel. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "./kit";
import s from "./kit.module.css";

type ToastKind = "info" | "error" | "success";
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  toast: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider(props: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { id, kind, message }]);
    // an error stays until it is dismissed, so it is never gone before it was read
    if (kind !== "error") setTimeout(() => dismiss(id), 3800);
  }, [dismiss]);
  const api = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={api}>
      {props.children}
      <div className={s.toastRegion} aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={[
              s.toast,
              t.kind === "error" ? s.toastError : t.kind === "success" ? s.toastSuccess : "",
            ].join(" ")}
          >
            {/* an error says so in words, not only by its colour, and stays until it is dismissed */}
            {t.kind === "error" ? <><strong>Error:</strong> {t.message}{" "}<Button size="sm" variant="ghost" onClick={() => dismiss(t.id)}>Clear error</Button></> : t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
