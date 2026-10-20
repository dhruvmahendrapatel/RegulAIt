import { useEffect, type ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useRouteError } from "react-router-dom";
import { Button, StatusDot } from "../ui/kit";

/**
 * What a screen shows when it cannot render (ADR-0196 U4). The usual cause is a screen's chunk that fails to load:
 * after a gateway upgrade, a tab opened before it asks for an old chunk hash and gets a 404, and a flaky link
 * drops the fetch. Without this the router showed its developer page, with a stack trace and asset URLs.
 *
 * - The panel never shows the error's message or stack: they name files and internals, not anything a person can act
 *   on. The error goes to the console instead.
 * - Reload is the recovery. React caches a lazy screen's rejected import, so re-rendering cannot fetch the chunk
 *   again; a reload does, and it also picks up the current deploy's chunk names.
 * - It does not reload by itself (vite's `vite:preloadError`): a failed client navigation would then throw away the
 *   screen the person is on, with anything they had typed into it.
 */

const CHUNK_LOAD = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // WebKit
  /Unable to preload CSS/i, // vite's preload helper
  /Loading (CSS )?chunk .* failed/i,
];

/** whether an error is a code chunk that failed to load, rather than a screen that threw while rendering */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || CHUNK_LOAD.some((re) => re.test(error.message));
}

export function RouteErrorPanel(props: { error: unknown; onReload?: () => void }) {
  const chunk = isChunkLoadError(props.error);
  return (
    <div style={{ padding: "var(--s5)", maxWidth: 720, margin: "0 auto" }}>
      <div role="alert" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "var(--s2)" }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: "var(--s2)", fontSize: "var(--text-lg)" }}>
          <StatusDot tone="danger" />
          {chunk ? "This page failed to load" : "Something went wrong on this page"}
        </h1>
        <p>
          {chunk
            ? "The app may have been updated since this tab was opened, or the connection dropped. Reload to fetch the current version."
            : "The page hit an unexpected error. Reload to try again. If it keeps happening, tell your administrator."}
        </p>
        <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
          <Button variant="primary" size="sm" onClick={props.onReload ?? (() => window.location.reload())}>
            Reload
          </Button>
          {/* a full load, so the home page comes from the current deploy too (the router's basename is /ui) */}
          <a href="/ui/">Go to the home page</a>
        </div>
      </div>
    </div>
  );
}

function logRouteError(error: unknown) {
  console.error("screen failed to render", error);
}

/**
 * The boundary inside the shell, around the signed-in screens, so the shell and its skip link stay mounted. It
 * clears when the path changes, so following a nav link away from a failed screen renders the next one. It resets
 * rather than remounts on navigation: a remount would mount a new Suspense boundary and show the loading fallback
 * where the transition keeps the current screen up.
 */
export function ShellRouteBoundary(props: { pathname: string; children: ReactNode }) {
  return (
    <ErrorBoundary resetKeys={[props.pathname]} onError={logRouteError} fallbackRender={({ error }) => <RouteErrorPanel error={error} />}>
      {props.children}
    </ErrorBoundary>
  );
}

/** the root route's errorElement: sign-in, the public feedback link and the forced gates render outside the shell */
export function RootRouteError() {
  const error = useRouteError();
  useEffect(() => logRouteError(error), [error]);
  return (
    <main id="rgMain" tabIndex={-1}>
      <RouteErrorPanel error={error} />
    </main>
  );
}
