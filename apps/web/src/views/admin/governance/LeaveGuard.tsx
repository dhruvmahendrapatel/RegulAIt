/**
 * ADR-0171 item 1 — "leaving a form with unsaved changes asks first".
 *
 * The app runs a <BrowserRouter> (react-router 7, not a data router), so
 * `useBlocker` is not available. The guard therefore sits at the three places
 * a person leaves from:
 *   - a page unload (refresh, closing the tab, typing an address): the
 *     browser's own `beforeunload` prompt, armed only while something is not
 *     yet saved (or a submission is in flight);
 *   - an in-app link (Cancel, the navigation rail, breadcrumbs, a similar use
 *     case): a capture-phase click listener stops the navigation and asks in
 *     the product's own dialog, then navigates if the person confirms;
 *   - the browser's Back button (ADR-0179): while the guard is on, a guard
 *     entry for this same page sits on top of the history. Back takes it off,
 *     so the page stays where it is; the guard puts it back and asks in the
 *     same dialog. "Leave" goes back past this page; "Stay" leaves things as
 *     they were. The draft hook also saves on leaving with a keepalive
 *     request, so an edit made just before Back is kept either way.
 * This is the history API, not a router migration: the guard entry carries the
 * router's own state (its key and index), so the router reads it as the same
 * page. A navigation away from the page replaces the guard entry, so Back from
 * the next page does not land on it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useHref, useNavigate } from "react-router-dom";
import { Button, Modal } from "../../../ui/kit";
import v from "../../views.module.css";

/** marks the guard entry this hook pushes onto the history (ADR-0179) */
export const GUARD_MARK = "regulaitLeaveGuard";
/** the pending destination when browser Back asked */
const BACK = "\u0000history-back";

const onGuardEntry = () => {
  const state = window.history.state as Record<string, unknown> | null;
  return Boolean(state && typeof state === "object" && state[GUARD_MARK]);
};

export function useLeaveGuard(opts: {
  /** ask before an in-app link or browser Back leaves the page */
  when: boolean;
  /** arm the browser's unload prompt */
  unloadWhen: boolean;
  title: string;
  body: ReactNode;
  /** run before navigating away once the person confirms (e.g. save the draft now) */
  beforeLeave?: () => Promise<unknown> | void;
}) {
  const navigate = useNavigate();
  const base = useHref("/").replace(/\/$/, "");
  const [pending, setPending] = useState<string | null>(null);
  const when = useRef(opts.when);
  when.current = opts.when;
  /** this page's guard entry is the current history entry (it survives a reload) */
  const armed = useRef(false);

  useEffect(() => {
    if (!opts.unloadWhen) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // older browsers show the prompt only when returnValue is set
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [opts.unloadWhen]);

  // ---- browser Back (ADR-0179) ---------------------------------------------
  const arm = useCallback(() => {
    if (armed.current || onGuardEntry()) {
      armed.current = true;
      return;
    }
    const state = window.history.state as Record<string, unknown> | null;
    window.history.pushState({ ...(state && typeof state === "object" ? state : {}), [GUARD_MARK]: true }, "", window.location.href);
    armed.current = true;
  }, []);

  useEffect(() => {
    if (onGuardEntry()) armed.current = true;
    const onPop = () => {
      if (onGuardEntry()) {
        // Forward onto this page's guard entry
        armed.current = true;
        return;
      }
      if (!armed.current) return;
      // Back took the guard entry off: the page has not moved
      armed.current = false;
      if (when.current) {
        arm();
        setPending(BACK);
      } else {
        // nothing to protect any more: carry on to where Back was going
        window.history.back();
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [arm]);

  useEffect(() => {
    if (opts.when) arm();
  }, [opts.when, arm]);

  /** go to an in-app path, over the guard entry when there is one */
  const go = useCallback((to: string) => {
    const replace = armed.current;
    armed.current = false;
    navigate(to, replace ? { replace: true } : undefined);
  }, [navigate]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (!when.current && !armed.current) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const raw = anchor.getAttribute("href") ?? "";
      if (raw.startsWith("#")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return;
      event.preventDefault();
      event.stopPropagation();
      const to = `${url.pathname.slice(base.length) || "/"}${url.search}${url.hash}`;
      if (when.current) setPending(to);
      else go(to);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [base, go]);

  /** ask before going to an in-app path (the page's own Cancel/Back-to-registry actions) */
  const requestLeave = useCallback((to: string) => {
    if (when.current) setPending(to);
    else go(to);
  }, [go]);

  const stay = useCallback(() => setPending(null), []);
  const [leaving, setLeaving] = useState(false);
  const leave = async () => {
    const to = pending;
    if (!to) return;
    setLeaving(true);
    try {
      await opts.beforeLeave?.();
    } finally {
      setLeaving(false);
      setPending(null);
      when.current = false;
      if (to === BACK) {
        // past the guard entry and this page's own entry: where Back was going
        const steps = armed.current ? -2 : -1;
        armed.current = false;
        window.history.go(steps);
      } else {
        go(to);
      }
    }
  };

  const dialog = (
    <Modal
      open={pending !== null}
      title={opts.title}
      onClose={stay}
      actions={
        <>
          <Button onClick={() => void leave()} disabled={leaving}>Leave</Button>
          <Button variant="primary" onClick={stay}>Stay on this page</Button>
        </>
      }
    >
      <div className={v.stack}>{opts.body}</div>
    </Modal>
  );
  return { dialog, requestLeave };
}
