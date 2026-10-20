import { useEffect, useSyncExternalStore } from "react";
import { Skeleton } from "../ui/kit";

/**
 * What a screen shows while its chunk loads (ADR-0196 U4, route-level code splitting). Only a first load reaches
 * it: a navigation runs in a transition, so the screen being left stays up until the next one is ready.
 *
 * - The box and bars match the auth probe's skeleton in Protected (App.tsx, a SkeletonBlock of five lines), so the
 *   probe handing over to this fallback moves nothing.
 * - It is announced as "Loading page" by RouteLoadingAnnouncer, a polite live region that is always mounted (beside
 *   the router in App.tsx) and only changes its text: many screen readers read nothing from a live region that
 *   is inserted together with its text. The region deliberately has no role="status" or aria-busy: those are what
 *   the harness's states check (e2e/enterprise/states.ent.spec.ts) reads as the SCREEN announcing its own data
 *   loading, and a code-loading fallback must not answer for a screen that does not. It sits outside <main> too.
 * - It takes no focus and lives inside the shell, so focus on a nav link or the skip link stays where it was.
 */
export function RouteFallback() {
  useEffect(() => {
    setLoading(1);
    return () => setLoading(-1);
  }, []);
  return (
    <div style={{ padding: "var(--s5)", maxWidth: 720, margin: "0 auto" }}>
      <div aria-hidden="true" style={{ display: "flex", flexDirection: "column", gap: "var(--s1)" }}>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} width={`${88 - ((i * 23) % 40)}%`} />
        ))}
      </div>
    </div>
  );
}

// how many fallbacks are up (the outer and the shell boundary can overlap for one commit)
let loading = 0;
const listeners = new Set<() => void>();
function setLoading(delta: number) {
  loading += delta;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function RouteLoadingAnnouncer() {
  const busy = useSyncExternalStore(subscribe, () => loading > 0, () => false);
  return (
    <span
      aria-live="polite"
      data-testid="route-loading"
      style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}
    >
      {busy ? "Loading page" : ""}
    </span>
  );
}
