/**
 * /ui — serves the built React SPA (apps/web/dist) from the gateway. Since
 * ADR-0033 removed the two ADR-0012 single-file shells, this is the ONLY UI
 * the product serves; /, /app and /admin are 302s into it.
 *
 * Contract (ADR-0026):
 *  - GET /ui and GET /ui/* are the ONLY routes this module registers — the
 *    API surface (/v1, /auth, /mcp) is untouched and can never be shadowed by
 *    a static file.
 *  - real files under dist/ are served with correct content types; hashed
 *    /ui/assets/* files get immutable caching, index.html gets no-cache;
 *  - any other /ui/* path falls back to index.html (SPA client routing);
 *  - path traversal is refused by resolution containment (never serve a byte
 *    outside dist/);
 *  - when dist/index.html is absent (dev without a web build) every /ui
 *    request answers a clear 503 "web bundle not built" — never a broken
 *    blank page.
 *
 * Dependency-free on purpose: a ~40-line resolver beats a static-serving
 * plugin we'd have to audit, and the SPA is a small fixed tree of files.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

/** route URLs this module registers — app.ts adds them to its auth-exempt and
 * non-admin route sets (a login page cannot require a credential). */
export const WEB_UI_ROUTES = ["/ui", "/ui/*"] as const;

/** default dist location: apps/web/dist relative to this file, which sits at
 * apps/gateway/{src,dist}/web-serving.* — both are two levels below apps/. */
export function defaultWebDistDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface WebServingOptions {
  /** override the dist directory (tests point this at fixtures) */
  distDir?: string;
}

export function registerWebServing(app: FastifyInstance, opts: WebServingOptions = {}) {
  // precedence: explicit option > REGULAIT_WEB_DIST (tests, exotic layouts) >
  // the workspace-relative default
  const distDir = path.resolve(
    opts.distDir ?? process.env.REGULAIT_WEB_DIST ?? defaultWebDistDir(),
  );
  const indexPath = path.join(distDir, "index.html");

  const sendFile = (reply: FastifyReply, filePath: string, cacheable: boolean) => {
    const ext = path.extname(filePath).toLowerCase();
    void reply
      .type(CONTENT_TYPES[ext] ?? "application/octet-stream")
      .header(
        "cache-control",
        cacheable ? "public, max-age=31536000, immutable" : "no-cache",
      )
      .header("x-content-type-options", "nosniff");
    return reply.send(createReadStream(filePath));
  };

  const sendIndex = (reply: FastifyReply) => {
    // checked per-request, not at boot: `vite build` landing while the
    // gateway runs starts serving without a restart (and vice versa).
    if (!existsSync(indexPath)) {
      return reply.status(503).send({
        error: "web_bundle_not_built",
        detail:
          "the web bundle is not built — run `pnpm --filter @regulait/web build` (or `pnpm -r build`). There is no fallback UI: the legacy /app and /admin shells were removed (ADR-0033), so the API at /v1 is the only surface until the bundle exists",
      });
    }
    return sendFile(reply, indexPath, false);
  };

  const handler = (rest: string, reply: FastifyReply) => {
    if (!rest) return sendIndex(reply);
    // containment: resolve inside dist and refuse anything that escapes it
    const resolved = path.resolve(distDir, rest);
    if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) {
      return sendIndex(reply); // traversal attempt → the SPA, never a file
    }
    let st;
    try {
      st = statSync(resolved);
    } catch {
      st = null;
    }
    if (st?.isFile()) {
      // hashed build assets are immutable; anything else re-validates
      const cacheable = rest.startsWith("assets/");
      return sendFile(reply, resolved, cacheable);
    }
    // not a real file → SPA fallback (client-side routes like /ui/runs/123)
    return sendIndex(reply);
  };

  app.get("/ui", async (_req, reply) => sendIndex(reply));
  app.get("/ui/*", async (req, reply) => {
    const rest = decodeURIComponent(((req.params as Record<string, string>)["*"] ?? "").trim());
    return handler(rest, reply);
  });
}
