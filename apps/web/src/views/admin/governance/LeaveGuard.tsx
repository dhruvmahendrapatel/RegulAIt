/**
 * Ask before leaving an edited intake (X13 / AER-050). React Router's blocker
 * covers links, programmatic navigation and same-app Back/Forward without
 * inserting synthetic history entries. Document exits use beforeunload.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBlocker, useNavigate, type BlockerFunction } from "react-router-dom";
import { Button, Modal } from "../../../ui/kit";
import v from "../../views.module.css";

export function useLeaveGuard(opts: {
  when: boolean;
  unloadWhen: boolean;
  title: string;
  body: ReactNode;
  /** Return false to keep the form when its latest changes cannot be saved. */
  beforeLeave?: () => Promise<boolean | void> | boolean | void;
}) {
  const navigate = useNavigate();
  const when = useRef(opts.when);
  when.current = opts.when;
  const shouldBlock = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) =>
    when.current && (
      currentLocation.pathname !== nextLocation.pathname ||
      currentLocation.search !== nextLocation.search
    ), []);
  const blocker = useBlocker(shouldBlock);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opts.unloadWhen) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [opts.unloadWhen]);

  useEffect(() => setError(null), [blocker.state, blocker.location?.key]);

  const stay = () => {
    if (leaving) return;
    if (blocker.state === "blocked") blocker.reset();
    setError(null);
  };
  const leave = async () => {
    if (blocker.state !== "blocked") return;
    setLeaving(true);
    setError(null);
    try {
      if (await opts.beforeLeave?.() === false) {
        setError("Your latest changes could not be saved. They are still on this page. Try Leave again to retry saving, or stay and keep editing.");
        return;
      }
      blocker.proceed();
    } catch {
      setError("Your latest changes could not be saved. They are still on this page. Try Leave again to retry saving, or stay and keep editing.");
    } finally {
      setLeaving(false);
    }
  };

  const requestLeave = useCallback((to: string) => navigate(to), [navigate]);
  const dialog = (
    <Modal
      open={blocker.state === "blocked"}
      title={opts.title}
      onClose={stay}
      actions={
        <>
          <Button onClick={() => void leave()} disabled={leaving}>Leave</Button>
          <Button variant="primary" onClick={stay} disabled={leaving}>Stay on this page</Button>
        </>
      }
    >
      <div className={v.stack}>
        {opts.body}
        {error && <p role="alert">{error}</p>}
      </div>
    </Modal>
  );
  return { dialog, requestLeave };
}
