/**
 * Gateway-side security headers (ADR-0031).
 *
 * The gateway serves the SPA itself and is directly reachable in dev (and on
 * the compose port in any deployment), so it cannot rely on an edge proxy to
 * add CSP / nosniff / frame-ancestors on its behalf. These headers are set at
 * the application, and any edge in front of it should be configured to agree
 * rather than to add a second, conflicting value: the `onSend` hook only fills
 * headers that are not already present, so a value set upstream on the same
 * response object always wins.
 *
 * CSP and the inline-script problem: the SPA's `index.html` carries one inline
 * `<script>` (the theme pre-paint that avoids a flash of the wrong theme), and
 * the two deprecated `/legacy/*` shells are single-file apps with an inline
 * `<script>` each. Rather than surrender to `'unsafe-inline'`, we hash the
 * inline scripts AT BOOT from the exact bytes that will be served and emit
 * `'sha256-…'` sources. That keeps working when the SPA bundle is rebuilt with
 * new hashed asset names, and it keeps working if the pre-paint script's text
 * changes — the hash is derived from the served file, never hardcoded.
 *
 * Disclosed relaxation: `style-src` keeps `'unsafe-inline'`. The deprecated
 * legacy shells carry large inline `<style>` blocks and inline `style="…"`
 * attributes that cannot be hashed together (a hash source makes the browser
 * ignore `'unsafe-inline'`, which would break them outright). The React SPA
 * does not need it — React sets styles through CSSOM, which CSP does not
 * govern — so this can tighten to `'self'` the release the `/legacy/*` shells
 * are removed. Recorded as a follow-up in ADR-0031.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/** CSP source expression for a literal inline script/style body. */
export function sha256Source(body: string): string {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

/** Every inline `<script>` body in an HTML document (those WITHOUT a `src`). */
export function inlineScriptBodies(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1] ?? "")) continue;
    out.push(m[2] ?? "");
  }
  return out;
}

// The registry of inline-script hashes the document CSP allows. Populated at
// boot from the actual served documents; a process-global is correct here
// because the documents themselves are process-global constants / build output.
const scriptHashes = new Set<string>();

/** Register every inline script in `html` as an allowed CSP source. */
export function registerInlineScripts(html: string): void {
  for (const body of inlineScriptBodies(html)) scriptHashes.add(sha256Source(body));
}

/**
 * Register the SPA shell's inline scripts, read from the built bundle. Silent
 * no-op when the bundle is absent — /ui already answers a clear 503 in that
 * case, so there is nothing to allow.
 */
export function registerSpaInlineScripts(distDir: string): boolean {
  try {
    registerInlineScripts(readFileSync(path.join(distDir, "index.html"), "utf8"));
    return true;
  } catch {
    return false;
  }
}

/** test seam — drops every registered hash */
export function resetInlineScriptHashes(): void {
  scriptHashes.clear();
}

export function registeredScriptSources(): string[] {
  return [...scriptHashes];
}

/** Documents (the SPA shell and the legacy shells). */
export function documentCsp(): string {
  const scriptSrc = ["'self'", ...scriptHashes].join(" ");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${scriptSrc}`,
    // disclosed relaxation — see the module header
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

/** Everything that is not a document: JSON, CSV, JS/CSS assets. Nothing on
 * these responses is ever meant to load a subresource. */
export function apiCsp(): string {
  return ["default-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join("; ");
}

/**
 * The full header set for one response. `contentType` decides which CSP
 * applies; pass the response's content-type (any non-HTML value gets the
 * locked-down API policy).
 */
export function securityHeaders(contentType: string | undefined): Record<string, string> {
  const isDocument = (contentType ?? "").toLowerCase().includes("text/html");
  return {
    "content-security-policy": isDocument ? documentCsp() : apiCsp(),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}
