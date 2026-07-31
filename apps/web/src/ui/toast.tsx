/** Toast — the app-wide, aria-live notification channel. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
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
  const toast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { id, kind, message }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3800);
  }, []);
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
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
