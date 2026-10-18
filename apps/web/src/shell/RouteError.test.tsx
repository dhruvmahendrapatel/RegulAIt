/**
 * ADR-0196 U4: a screen whose chunk fails to load shows a recovery panel, never the router's developer page with
 * its stack trace. Rendered with react-dom/server (no DOM); the browser path (an aborted chunk, inside the shell
 * and outside it) is e2e/enterprise/route-chunks.ent.spec.ts.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isChunkLoadError, RouteErrorPanel } from "./RouteError";
import { RouteFallback, RouteLoadingAnnouncer } from "./RouteFallback";

const CHUNK = "Failed to fetch dynamically imported module: http://127.0.0.1/ui/assets/admin-settings-BrmRUqqk.js";

describe("isChunkLoadError", () => {
  it.each([
    ["Chromium", new TypeError(CHUNK)],
    ["Firefox", new TypeError("error loading dynamically imported module: http://127.0.0.1/ui/assets/auth-x.js")],
    ["WebKit", new TypeError("Importing a module script failed.")],
    ["vite preload", new Error("Unable to preload CSS for /ui/assets/admin-settings-x.css")],
  ])("recognises %s's failed import", (_, e) => expect(isChunkLoadError(e)).toBe(true));

  it("does not take a render error or a non-error for one", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'length')"))).toBe(false);
    expect(isChunkLoadError(CHUNK)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("RouteErrorPanel", () => {
  it("offers Reload and the way home for a failed chunk, and never shows the error's URL or stack", () => {
    const e = new TypeError(CHUNK);
    const html = renderToStaticMarkup(<RouteErrorPanel error={e} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("This page failed to load");
    expect(html).toContain(">Reload<");
    expect(html).toContain('href="/ui/"');
    expect(html).not.toContain("assets/");
    expect(html).not.toContain("dynamically imported");
    expect(html).not.toContain(e.stack!.split("\n")[1]!.trim());
  });

  it("says something went wrong for a screen that threw, without its message", () => {
    const html = renderToStaticMarkup(<RouteErrorPanel error={new TypeError("Cannot read properties of undefined")} />);
    expect(html).toContain("Something went wrong on this page");
    expect(html).toContain(">Reload<");
    expect(html).not.toContain("Cannot read properties");
  });
});

describe("RouteFallback", () => {
  it("is skeleton only, hidden from assistive technology, with no status role, busy state or focus target", () => {
    const html = renderToStaticMarkup(<RouteFallback />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/role="status"|aria-busy|aria-live|tabindex/);
  });

  it("announces through a live region that is mounted empty, so the text arrives as a change", () => {
    const html = renderToStaticMarkup(<RouteLoadingAnnouncer />);
    expect(html).toMatch(/<span aria-live="polite"[^>]*><\/span>/);
    expect(html).not.toContain("role=");
  });
});
