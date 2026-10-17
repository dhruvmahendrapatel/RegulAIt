// GET-only HTTP for the repo readers: rate-limit backoff, same-origin
// pagination and the bounds every reader shares (ADR-0195 decisions 8-9, 14).

import { scrubSecrets } from "@regulait/shared";
import { GitProviderError } from "../types.js";
import { trimTrailingSlashes } from "../url.js";
import { REPO_READ_DEFAULTS, type ReadFetchLike, type ReadResponse, type RepoReaderOptions } from "./types.js";

/**
 * Thrown when the provider keeps rate-limiting after the retries, or asks for
 * a wait longer than `maxWaitMs`. `retryAfterMs` lets the SD0 worker release
 * its lease and reschedule instead of sleeping inside a run.
 */
export class GitProviderRateLimitError extends GitProviderError {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message, 429);
  }
}

/** thrown by every history method on a reader built without `allowHistory` */
export class HistoryScanDisabledError extends GitProviderError {
  constructor() {
    super(
      "history scanning is an admin relaxation (ADR-0195 decision 14) and is off for this source; only the default branch head is read",
      403,
    );
  }
}

const HEADER_MAX = 4_096;

function header(res: ReadResponse, name: string): string | null {
  const v = res.headers?.get(name) ?? null;
  return v === null || v.length > HEADER_MAX ? null : v;
}

const isDigits = (s: string): boolean => s.length > 0 && s.length <= 12 && [...s].every((c) => c >= "0" && c <= "9");

/** Retry-After as delta-seconds or an HTTP date; null when absent or unreadable */
export function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (isDigits(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * The `rel="next"` target of an RFC 8288 Link header (GitHub). Split on `,`
 * and `;` with no regex, so a hostile header is linear to read.
 */
export function nextLinkFromHeader(value: string | null): string | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    const pieces = part.split(";").map((p) => p.trim());
    const target = pieces[0] ?? "";
    if (!target.startsWith("<") || !target.endsWith(">")) continue;
    if (pieces.slice(1).some((p) => p === 'rel="next"' || p === "rel=next")) return target.slice(1, -1);
  }
  return null;
}

/** validate a repo address: `minSegments` to `maxSegments` segments, none empty, `.` or `..` */
export function repoSegments(repo: string, minSegments = 2, maxSegments = 2): string[] {
  if (repo.length === 0 || repo.length > 512) throw new GitProviderError(`invalid repo '${repo.slice(0, 80)}'`, 400);
  const segs = repo.split("/");
  if (
    segs.length < minSegments ||
    segs.length > maxSegments ||
    segs.some((s) => s.length === 0 || s === "." || s === ".." || s.includes("\\"))
  ) {
    throw new GitProviderError(`invalid repo '${repo.slice(0, 80)}'`, 400);
  }
  return segs;
}

/** the repo address with each segment URL-encoded, for a request path (exactly owner/name by default) */
export function encodeRepo(repo: string, minSegments = 2, maxSegments = 2): string {
  return repoSegments(repo, minSegments, maxSegments).map(encodeURIComponent).join("/");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A reader's API base: https with no credentials, query or fragment. Plain
 * http is accepted only for a loopback host (the package's own fake-upstream
 * tests); the gateway's guarded fetch refuses loopback in production anyway.
 */
export function assertApiBase(label: string, baseUrl: string): URL {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new GitProviderError(`${label}: baseUrl is not a URL`, 400);
  }
  const httpsOk = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname));
  if (!httpsOk || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") {
    throw new GitProviderError(`${label}: baseUrl must be an https URL with no credentials, query or fragment`, 400);
  }
  return u;
}

/** a file path inside a repo, each segment URL-encoded; refuses traversal */
export function encodeRepoPath(path: string): string {
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  if (trimmed.length === 0 || trimmed.length > 4_096) throw new GitProviderError("invalid file path", 400);
  const segs = trimmed.split("/");
  if (segs.some((s) => s.length === 0 || s === "." || s === "..")) {
    throw new GitProviderError("invalid file path", 400);
  }
  return segs.map(encodeURIComponent).join("/");
}

/** a commit sha as the readers accept it: 7-64 hex characters */
export function assertCommitSha(sha: string): string {
  if (sha.length < 7 || sha.length > 64 || ![...sha].every((c) => "0123456789abcdefABCDEF".includes(c))) {
    throw new GitProviderError("invalid commit sha", 400);
  }
  return sha;
}

export function clampLimit(value: number | undefined, fallback: number, ceiling = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), ceiling));
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ReadClientInit {
  label: string;
  baseUrl: string;
  token: string;
  authHeaders: Record<string, string>;
  opts: RepoReaderOptions;
}

/** GET with backoff. One instance per reader. */
export class ReadClient {
  readonly base: string;
  readonly origin: string;
  readonly maxPages: number;
  private readonly fetchImpl: ReadFetchLike;
  private readonly maxRetries: number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** the token and its derived auth forms, scrubbed from any error text */
  readonly secrets: string[];

  constructor(private readonly init: ReadClientInit) {
    if (typeof init.opts.fetchImpl !== "function") {
      // secure by default: there is no unguarded fallback transport
      throw new GitProviderError(`${init.label} reader requires an injected guarded fetch`);
    }
    this.base = trimTrailingSlashes(init.baseUrl);
    this.origin = assertApiBase(init.label, this.base).origin;
    // the token and every auth header value derived from it (Basic base64 forms) are scrubbed from errors
    this.secrets = [init.token, ...Object.values(init.authHeaders).flatMap((v) => [v, v.slice(v.indexOf(" ") + 1)])].filter((x) => x.length >= 8);
    this.fetchImpl = init.opts.fetchImpl;
    // 0 is meaningful: the caller (SD0's ctx.backoff) does the waiting itself
    const retries = init.opts.maxRetries;
    this.maxRetries =
      retries === undefined || !Number.isFinite(retries) ? REPO_READ_DEFAULTS.maxRetries : Math.max(0, Math.min(Math.floor(retries), 10));
    this.maxWaitMs = clampLimit(init.opts.maxWaitMs, REPO_READ_DEFAULTS.maxWaitMs, 15 * 60_000);
    this.maxPages = clampLimit(init.opts.maxPages, REPO_READ_DEFAULTS.maxPages, 10_000);
    this.sleep = init.opts.sleep ?? defaultSleep;
    this.now = init.opts.now ?? Date.now;
  }

  /** resolve a path (or an absolute pagination link) against the base, same origin only */
  url(pathOrUrl: string): string {
    if (pathOrUrl.startsWith("/")) return `${this.base}${pathOrUrl}`;
    const u = new URL(pathOrUrl);
    if (u.origin !== this.origin) {
      throw new GitProviderError(`${this.init.label}: refusing a pagination link to another origin (${u.origin})`, 502);
    }
    return u.toString();
  }

  private waitFor(res: ReadResponse, attempt: number): number | null {
    const retryAfter = parseRetryAfterMs(header(res, "retry-after"), this.now());
    if (retryAfter !== null) return retryAfter;
    const reset = header(res, "x-ratelimit-reset") ?? header(res, "ratelimit-reset");
    if (reset !== null && isDigits(reset.trim())) {
      const n = Number(reset.trim());
      // GitHub sends an epoch second; GitLab's RateLimit-Reset is also an epoch second
      if (n > 1_000_000_000) return Math.max(0, n * 1000 - this.now());
      return n * 1000;
    }
    return REPO_READ_DEFAULTS.baseBackoffMs * 2 ** attempt;
  }

  private isRateLimited(res: ReadResponse): boolean {
    if (res.status === 429) return true;
    if (res.status === 503 && header(res, "retry-after") !== null) return true;
    // GitHub answers a spent primary or secondary limit with 403
    return res.status === 403 && (header(res, "x-ratelimit-remaining") === "0" || header(res, "retry-after") !== null);
  }

  async get(pathOrUrl: string, extraHeaders: Record<string, string> = {}, method: "GET" | "HEAD" = "GET"): Promise<ReadResponse> {
    const target = this.url(pathOrUrl);
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(target, {
        method,
        headers: { ...this.init.authHeaders, "user-agent": "regulait-repo-scanner", ...extraHeaders },
      });
      if (this.isRateLimited(res)) {
        const wait = this.waitFor(res, attempt);
        if (attempt >= this.maxRetries || wait === null || wait > this.maxWaitMs) {
          throw new GitProviderRateLimitError(
            `${this.init.label}: rate limited (HTTP ${res.status}) after ${attempt + 1} attempt(s)`,
            wait,
          );
        }
        await this.sleep(wait);
        continue;
      }
      if (res.status >= 300 && res.status < 400) {
        throw new GitProviderError(`${this.init.label}: unexpected redirect (HTTP ${res.status}); point baseUrl at the final API host`, res.status);
      }
      return res;
    }
  }

  /** throw the scrubbed error for a failed response */
  async fail(res: ReadResponse, hint: (status: number) => string): Promise<never> {
    const capped = await readCapped(res, 2_000);
    const body = scrubSecrets(capped.text ?? "", this.secrets);
    throw new GitProviderError(`${this.init.label} GET failed (HTTP ${res.status})${hint(res.status)}: ${body}`, res.status);
  }

  /** GET that throws a scrubbed GitProviderError on any 4xx/5xx */
  async getOk(pathOrUrl: string, hint: (status: number) => string, extraHeaders?: Record<string, string>): Promise<ReadResponse> {
    const res = await this.get(pathOrUrl, extraHeaders);
    if (res.status >= 400) await this.fail(res, hint);
    return res;
  }

  async getJson<T>(pathOrUrl: string, hint: (status: number) => string, extraHeaders?: Record<string, string>): Promise<{ body: T; res: ReadResponse }> {
    const res = await this.getOk(pathOrUrl, hint, extraHeaders);
    return { body: (await res.json()) as T, res };
  }

  header(res: ReadResponse, name: string): string | null {
    return header(res, name);
  }
}

/**
 * Read a response body, stopping as soon as it passes `maxBytes`: a file
 * larger than the cap is never fully downloaded. `text` is null when the cap
 * was passed. Falls back to `text()` (then checks) when there is no stream.
 */
export async function readCapped(res: ReadResponse, maxBytes: number): Promise<{ text: string | null; bytes: number }> {
  const declared = Number(res.headers?.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { text: null, bytes: declared };
  }
  if (!res.body) {
    const t = await res.text();
    const bytes = Buffer.byteLength(t);
    return bytes > maxBytes ? { text: null, bytes } : { text: t, bytes };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { text: null, bytes };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes };
}

/** read a JSON body under a byte cap; `tooLarge` when the cap was passed */
export async function readJsonCapped<T>(res: ReadResponse, maxBytes: number): Promise<{ body: T | null; tooLarge: boolean }> {
  const r = await readCapped(res, maxBytes);
  if (r.text === null) return { body: null, tooLarge: true };
  return { body: JSON.parse(r.text) as T, tooLarge: false };
}

/** the JSON envelope cap for a base64 file payload of at most `maxBytes` decoded bytes */
export const base64EnvelopeCap = (maxBytes: number): number => Math.ceil((maxBytes * 4) / 3) + 16_384;

/** decode a base64 payload as UTF-8; null when it holds a NUL byte (binary) */
export function decodeBase64Text(b64: string): string | null {
  const buf = Buffer.from(b64.replace(/\s+/g, ""), "base64");
  if (buf.includes(0)) return null;
  return buf.toString("utf8");
}

export function looksBinary(text: string): boolean {
  return text.includes("\u0000");
}

/** "Name <email>" (Bitbucket's `author.raw`) split without a regex */
export function splitRawAuthor(raw: string | null | undefined): { name: string | null; email: string | null } | null {
  if (!raw) return null;
  const lt = raw.lastIndexOf("<");
  const gt = raw.lastIndexOf(">");
  if (lt !== -1 && gt > lt) {
    const name = raw.slice(0, lt).trim();
    return { name: name || null, email: raw.slice(lt + 1, gt).trim() || null };
  }
  return { name: raw.trim() || null, email: null };
}
