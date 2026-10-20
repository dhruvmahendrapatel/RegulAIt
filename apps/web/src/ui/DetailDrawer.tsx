import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, tabTrap } from "./kit";
import d from "./detailDrawer.module.css";

/**
 * Below this width the drawer leaves too little of the page beside it to use, so it covers the page and is modal.
 * Keep in step with the `.drawer` overlay rule in detailDrawer.module.css.
 */
export const DRAWER_OVERLAY_QUERY = "(max-width: 900px)";

function useOverlay() {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(DRAWER_OVERLAY_QUERY);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DRAWER_OVERLAY_QUERY).matches,
    () => false,
  );
}

/** the drawer's pinned footer; undefined outside a drawer, null until the footer has mounted */
const FooterSlot = createContext<HTMLElement | null | undefined>(undefined);

/**
 * L2 (ADR-0180): a decision or step-up action row. Inside a DetailDrawer it is pinned in the drawer's footer, which
 * never scrolls, so the action cannot scroll out of view; a submit button there names its form with `form`.
 * Anywhere else it renders in place.
 */
export function DrawerActions(props: { children: ReactNode; className?: string }) {
  const slot = useContext(FooterSlot);
  if (slot === undefined) return props.className ? <div className={props.className}>{props.children}</div> : <>{props.children}</>;
  return slot ? createPortal(props.children, slot) : null;
}

/**
 * A1: the one detail drawer for a row's detail (a finding's triage or remediation plan, a use-case preview).
 *
 * Focus and the page behind it (M2):
 * - Wide screens (above DRAWER_OVERLAY_QUERY): a non-modal side panel (`dialog.show()`). The list stays visible and
 *   reachable beside it: Tab leaves the drawer into the page in document order, and a pointer can pick another row,
 *   which re-targets the drawer.
 * - Phones and narrow windows: the drawer covers the page, so it is modal (`dialog.showModal()`). The page behind it is
 *   inert (not focusable, not in the accessibility tree), Tab wraps inside the drawer, and the top bar is
 *   unreachable until the drawer closes. Resizing across the width switches the mode in place.
 *
 * Escape closes only the innermost layer (M1): an open (i) tip or a dialog opened from the drawer takes it first.
 * The heading takes focus whenever the subject changes; on close, focus returns to the control that opened the
 * current subject (L1).
 */
export function DetailDrawer(props: {
  /** small caption above the title, e.g. "Shadow-AI finding" */
  type: string;
  title: ReactNode;
  /** status badges under the title */
  meta?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
  /** a stable id for the heading, when a caller's tests or links need one */
  headingId?: string;
  /** changes when the drawer shows another record, to move focus to the new heading */
  subjectKey?: string;
  "data-testid"?: string;
}) {
  const autoId = useId();
  const headingId = props.headingId ?? `${autoId}-title`;
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const overlay = useOverlay();
  const { onClose } = props;

  // the page reserves room for an open side panel (detailDrawer.module.css); counted, as two may be open at once
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.rgDrawer = String(Number(root.dataset.rgDrawer ?? 0) + 1);
    return () => {
      const left = Number(root.dataset.rgDrawer ?? 1) - 1;
      if (left > 0) root.dataset.rgDrawer = String(left);
      else delete root.dataset.rgDrawer;
    };
  }, []);
  // L1: the opener is whatever had focus when this subject was opened, captured before the drawer takes focus.
  // Focus already inside the drawer means the subject changed from within it, so the earlier opener stands.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !ref.current?.contains(active)) opener.current = active;
  }, [props.subjectKey]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const had = dialog.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    if (dialog.open) dialog.close();
    if (overlay) dialog.showModal();
    else dialog.show();
    had?.focus();
  }, [overlay]);
  useLayoutEffect(() => {
    heading.current?.focus();
  }, [props.subjectKey]);
  // On close, focus goes back to the opener only when it was lost with the drawer: when another drawer replaced this
  // one, the new heading already holds focus and keeps it.
  useEffect(
    () => () => {
      const el = opener.current;
      const active = document.activeElement;
      if ((!active || active === document.body) && el?.isConnected) el.focus();
    },
    [],
  );
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (overlay) {
      // modal: the browser sends Escape to the topmost dialog as `cancel`; Tab wraps like the kit Modal's
      const trap = tabTrap(dialog);
      document.addEventListener("keydown", trap);
      return () => document.removeEventListener("keydown", trap);
    }
    // non-modal: on the window, so a tip's own document listener has already spent the Escape it consumes
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // a modal opened from the drawer (or anywhere) owns Escape while it is open
      if (document.querySelector('dialog[open][aria-modal="true"]')) return;
      const active = document.activeElement;
      // focus out in the page belongs to the page, not to this drawer
      if (active && active !== document.body && !dialog.contains(active)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, onClose]);

  return (
    <dialog
      ref={ref}
      className={overlay ? `${d.drawer} ${d.overlay}` : d.drawer}
      aria-modal={overlay ? "true" : "false"}
      aria-labelledby={headingId}
      data-testid={props["data-testid"]}
      onCancel={(e) => {
        // a dialog nested in this one cancels itself; React would otherwise hand its cancel up to this handler
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClose();
      }}
    >
      <div className={d.head}>
        <div className={d.titleBlock}>
          <span className={d.type}>{props.type}</span>
          <h2 id={headingId} ref={heading} tabIndex={-1} className={d.title}>
            {props.title}
          </h2>
          {props.meta ? <div className={d.meta}>{props.meta}</div> : null}
        </div>
        <Button variant="ghost" size="sm" className={d.close} onClick={props.onClose} aria-label={props.closeLabel ?? "Close details"}>
          Close
        </Button>
      </div>
      <FooterSlot.Provider value={footer}>
        <div className={d.body}>{props.children}</div>
      </FooterSlot.Provider>
      <div ref={setFooter} className={d.footer} />
    </dialog>
  );
}
