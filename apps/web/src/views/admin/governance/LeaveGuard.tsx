/**
 * ADR-0171 item 1 — "leaving a form with unsaved changes asks first".
 *
 * The app runs a <BrowserRouter> (react-router 7, not a data router), so
 * `useBlocker` is not available. The guard therefore sits at the two places a
 * person leaves from:
 *   - a page unload (refresh, closing the tab, typing an address): the
 *     browser's own `beforeunload` prompt, armed only while something is not
 *     yet saved (or a submission is in flight);
 *   - an in-app link (Cancel, the navigation rail, breadcrumbs, a similar use
 *     case): a capture-phase click listener stops the navigation and asks in
 *     the product's own dialog, then navigates if the person confirms.
 * The browser's Back button inside the app is not intercepted; the draft is
 * saved on the server, so the work is still there to resume.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useHref, useNavigate } from "react-router-dom";
import { Button, Modal } from "../../../ui/kit";
import v from "../../views.module.css";

export function useLeaveGuard(opts: {
  /** ask before an in-app link leaves the page */
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

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!when.current || event.defaultPrevented || event.button !== 0) return;
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
      setPending(`${url.pathname.slice(base.length) || "/"}${url.search}${url.hash}`);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [base]);

  /** ask before going to an in-app path (the page's own Cancel/Back-to-registry actions) */
  const requestLeave = useCallback((to: string) => {
    if (when.current) setPending(to);
    else navigate(to);
  }, [navigate]);

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
      navigate(to);
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
