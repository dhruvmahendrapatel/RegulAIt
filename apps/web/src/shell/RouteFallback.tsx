import { SkeletonBlock } from "../ui/kit";

/**
 * What a screen shows while its chunk loads (ADR-0196 U4, route-level code splitting). Only a first load reaches
 * it: a navigation runs in a transition, so the screen being left stays up until the next one is ready.
 *
 * - The box matches the auth probe's skeleton in Protected (App.tsx), so the probe handing over to this fallback
 *   moves nothing.
 * - One polite status region with text, so a screen reader hears "Loading page" once; the skeleton bars (whose
 *   own status role would announce a second time) are hidden from it.
 * - It takes no focus and lives inside the shell, so focus on a nav link or the skip link stays where it was.
 */
export function RouteFallback() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" style={{ padding: "var(--s5)", maxWidth: 720, margin: "0 auto" }}>
      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}>
        Loading page
      </span>
      <div aria-hidden="true">
        <SkeletonBlock lines={5} />
      </div>
    </div>
  );
}
