/**
 * ADR-0171 item 1 — the intake's server-side draft. One per signed-in user
 * and scope ("new" for a registration, the use case's id for a resubmission),
 * read and written only through `GET/PUT/DELETE /v1/use-cases/draft`. Nothing
 * here touches browser storage: questionnaire text can be sensitive.
 *
 * The page hands this hook a snapshot of its state (or null while there is
 * nothing worth keeping). A changed snapshot is saved about a second after the
 * last change, or at once on `flush()` (a step change, leaving); whatever is
 * still unsaved when the page goes is sent with a keepalive request (ADR-0179).
 * `flush()` answers whether the server holds the snapshot. Saves are
 * serialised, so a delete after a successful submission always lands after
 * the last save and never leaves a stale draft behind.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, CSRF_HEADER, api } from "../../../api/client";
import { canonicalDigest } from "./intakeCheckpoint";

export interface DraftRecord { scope: string; state: unknown; updatedAt: string }

export type DraftStatus =
  /** drafts cannot be kept: not a signed-in person, or the gateway does not offer them */
  | { kind: "off"; reason: "not-signed-in" | "unavailable" }
  | { kind: "loading" }
  /** a saved draft was found; nothing is saved until the person resumes it or starts fresh */
  | { kind: "offer"; draft: DraftRecord }
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "error"; tooLarge: boolean }
  /** submitted: the draft is gone and nothing more is saved */
  | { kind: "done" };

/**
 * What a save answered (ADR-0179):
 *   saved     the server holds the latest snapshot (now or already);
 *   not-kept  nothing was sent: drafts are off, a resume offer is still open,
 *             the first read has not answered, nothing is worth keeping, or
 *             the draft is finished;
 *   failed    the save was refused or did not arrive; the server holds an
 *             older snapshot or none.
 */
export type DraftSaveOutcome =
  | { kind: "saved" }
  | { kind: "not-kept"; reason: "off" | "offer" | "loading" | "empty" | "stopped" }
  | { kind: "failed"; tooLarge: boolean };

/**
 * May a request whose retry depends on the draft (a create carrying an
 * Idempotency-Key kept in it) be sent after this save? Only when the server
 * holds the key, or when no draft is kept at all, so no older draft can be
 * resumed without it. A failed save, or a first read still loading, refuses:
 * the server may hold an older draft without the key.
 */
export const durableForSubmit = (outcome: DraftSaveOutcome): boolean =>
  outcome.kind === "saved" || (outcome.kind === "not-kept" && (outcome.reason === "off" || outcome.reason === "offer"));

const SAVE_DELAY_MS = 1000;
/** a keepalive request body may be at most 64 KiB; a larger exit save goes as an ordinary request */
const KEEPALIVE_MAX_BYTES = 60_000;
export const draftPath = (scope: string) => `/v1/use-cases/draft?scope=${encodeURIComponent(scope)}`;

/** the exit save: same credential and CSRF header as the api client, sent with `keepalive` */
async function putOnExit(path: string, body: string): Promise<boolean> {
  const payload = JSON.stringify({ state: JSON.parse(body) as unknown });
  try {
    const res = await fetch(path, {
      method: "PUT",
      credentials: "include",
      keepalive: new Blob([payload]).size <= KEEPALIVE_MAX_BYTES,
      headers: { [CSRF_HEADER]: "1", "content-type": "application/json" },
      body: payload,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function useIntakeDraft<S>(opts: {
  scope: string;
  enabled: boolean;
  /** the state to keep; null while the form holds nothing worth saving */
  snapshot: S | null;
}) {
  const { scope, enabled } = opts;
  const [status, setStatus] = useState<DraftStatus>(enabled ? { kind: "loading" } : { kind: "off", reason: "not-signed-in" });
  const statusRef = useRef(status);
  statusRef.current = status;
  // compared in canonical form: the server may hand the state back with its keys reordered
  const serialized = opts.snapshot === null ? null : canonicalDigest(opts.snapshot);
  const latest = useRef(serialized);
  latest.current = serialized;
  /** the last snapshot the server holds (or null when it holds none) */
  const saved = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const stopped = useRef(false);
  /** the snapshot the last refused save tried to store */
  const failed = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.get<{ draft?: DraftRecord | null }>(draftPath(scope)).then(
      (res) => {
        if (!live) return;
        const draft = res?.draft ?? null;
        setStatus(draft ? { kind: "offer", draft } : { kind: "idle" });
      },
      () => {
        if (live) setStatus({ kind: "off", reason: "unavailable" });
      },
    );
    return () => { live = false; };
  }, [enabled, scope]);

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  /**
   * save the latest snapshot now (serialised behind any save already in
   * flight); `override` is the state to save when it changed outside a render
   * (the submission's progress, kept in refs).
   *
   * ADR-0179: it answers whether the server now holds that snapshot. A failed
   * save used to resolve like a successful one, so the wizard created the use
   * case while its attempt key existed only in page memory; a lost response
   * and a reload then resumed an older draft without the key, and a retry
   * created a second use case. The caller decides from the outcome.
   */
  const save = useCallback((override?: S): Promise<DraftSaveOutcome> => {
    clearTimer();
    if (override !== undefined) latest.current = canonicalDigest(override);
    const run = queue.current.then(async (): Promise<DraftSaveOutcome> => {
      const body = latest.current;
      const kind = statusRef.current.kind;
      if (stopped.current) return { kind: "not-kept", reason: "stopped" };
      if (kind === "off" || kind === "offer" || kind === "loading") return { kind: "not-kept", reason: kind };
      if (body === null) return { kind: "not-kept", reason: "empty" };
      if (body === saved.current) return { kind: "saved" };
      setStatus({ kind: "saving" });
      try {
        const res = await api.put<{ draft?: DraftRecord }>(draftPath(scope), { state: JSON.parse(body) as unknown });
        saved.current = body;
        if (!stopped.current) {
          // a change made while this save was in flight is still waiting
          setStatus(latest.current === body ? { kind: "saved", at: res?.draft?.updatedAt ?? new Date().toISOString() } : { kind: "pending" });
        }
        return { kind: "saved" };
      } catch (error) {
        failed.current = body;
        const tooLarge = error instanceof ApiError && error.status === 413;
        if (!stopped.current) setStatus({ kind: "error", tooLarge });
        return { kind: "failed", tooLarge };
      }
    });
    queue.current = run.catch(() => undefined);
    return run;
  }, [scope]);

  /**
   * ADR-0179: leaving the page (an in-app navigation, browser Back, closing
   * the tab) must not drop the last edit. The debounce timer dies with the
   * page, so whatever the server does not hold yet is sent now with a
   * keepalive request, which the browser completes even as the page goes.
   * Only while the draft is being kept (never at the resume offer, never once
   * submitted), and after a save already in flight, so it cannot be
   * overtaken by an older body.
   */
  const saveOnExit = useCallback(() => {
    clearTimer();
    const body = latest.current;
    const kind = statusRef.current.kind;
    if (stopped.current || body === null || body === saved.current) return;
    if (kind === "off" || kind === "offer" || kind === "loading" || kind === "done") return;
    const send = () => {
      if (body === saved.current) return;
      void putOnExit(draftPath(scope), body).then((ok) => {
        if (ok) saved.current = body;
      });
    };
    if (kind === "saving") void queue.current.then(send);
    else send();
  }, [scope]);
  const exitRef = useRef(saveOnExit);
  exitRef.current = saveOnExit;
  useEffect(() => {
    const onPageHide = () => exitRef.current();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // a changed snapshot is saved about a second after the last change
  useEffect(() => {
    const kind = statusRef.current.kind;
    if (stopped.current || kind === "off" || kind === "offer" || kind === "loading" || serialized === null || serialized === saved.current) return;
    // a save in flight re-schedules itself when it lands (status "pending");
    // a refused save is tried again after the next change, never in a loop
    if (kind === "saving" || (kind === "error" && serialized === failed.current)) return;
    setStatus((s) => (s.kind === "pending" ? s : { kind: "pending" }));
    clearTimer();
    timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
  }, [serialized, save, status.kind]);

  // unmounting (an in-app navigation or browser Back) saves what is not saved yet
  useEffect(() => () => exitRef.current(), []);

  /** take the offered draft: the caller restores its state; saving resumes from it */
  const resume = useCallback((): DraftRecord | null => {
    const s = statusRef.current;
    if (s.kind !== "offer") return null;
    saved.current = canonicalDigest(s.draft.state);
    setStatus({ kind: "saved", at: s.draft.updatedAt });
    return s.draft;
  }, []);

  /** drop the offered draft and start from a blank form */
  const startFresh = useCallback(async () => {
    saved.current = null;
    setStatus({ kind: "idle" });
    try {
      // the literal path keeps this delete visible to the UI-affordance check
      await api.del(`/v1/use-cases/draft?scope=${encodeURIComponent(scope)}`);
    } catch {
      // the next save replaces it anyway
    }
  }, [scope]);

  /** after a successful submission: stop saving, then delete the draft once every save has landed */
  const discard = useCallback(async () => {
    // a saved draft the person never chose to resume is theirs to keep: only this page's own draft goes
    const ownDraft = statusRef.current.kind !== "offer";
    stopped.current = true;
    clearTimer();
    setStatus({ kind: "done" });
    if (!ownDraft) return;
    const run = queue.current.then(() => api.del(draftPath(scope)).catch(() => undefined));
    queue.current = run.catch(() => undefined);
    await run;
  }, [scope]);

  const unsaved = (() => {
    if (serialized === null || status.kind === "done") return false;
    if (status.kind === "off" || status.kind === "error") return true;
    return serialized !== saved.current;
  })();

  return { status, unsaved, flush: save, resume, startFresh, discard };
}

/** "Draft saved 14:05" — the time in the viewer's own clock */
export const savedAtText = (iso: string) => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const today = new Date().toDateString() === at.toDateString();
  return today
    ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
