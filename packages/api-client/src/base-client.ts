/**
 * ADR-0053 — the hand-written runtime half of the generated TypeScript client.
 *
 * Deliberately tiny and dependency-free, in keeping with ADR-0012's posture: a
 * client SDK that drags an HTTP stack into an integrator's application is a
 * supply-chain liability we would be imposing on our customers. This uses the
 * platform `fetch` (Node >=18, every browser, every edge runtime) and nothing
 * else, and lets a caller inject their own `fetch` for tests, proxies, or a
 * runtime where the global one is not the one they want used.
 *
 * THE CREDENTIAL IS THE EXISTING ONE. ADR-0053 §4: the public API introduces no
 * new auth. This sends an ADR-0025 API key as `Authorization: Bearer <key>` —
 * the same header the gateway has always accepted. There is no token exchange,
 * no refresh, and no OAuth app model here, because there is none in the product.
 *
 * WHAT THIS CLIENT DOES NOT DO. It does not retry, and it does not silently
 * back off. A 429 carries `retry-after` and is surfaced as a typed error with
 * that value attached; deciding whether to retry a governed, metered, audited
 * call belongs to the caller, not to us.
 */

export interface RequestOptions {
  /** query-string parameters. `undefined` values are omitted entirely. */
  query?: Record<string, string | number | boolean | undefined>;
  /** extra headers merged over the defaults (Authorization cannot be unset) */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RegulAItClientOptions {
  /** e.g. `https://regulait.internal.example.com` — no trailing slash needed */
  baseUrl: string;
  /** an ADR-0025 API key (`rgl_...`). Sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** inject a fetch implementation (tests, proxies, non-global runtimes) */
  fetch?: typeof globalThis.fetch;
  /** merged into every request; per-request headers win */
  defaultHeaders?: Record<string, string>;
}

/**
 * A non-2xx response. Carries the parsed body when the server sent JSON, the
 * raw text otherwise — an error that hides the server's own explanation is
 * worse than no client at all.
 */
export class RegulAItApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSeconds: number | null;
  /** RFC 8594 — set when the route this call hit is on a sunset clock */
  readonly deprecation: { deprecation: string; sunset: string | null } | null;

  constructor(
    status: number,
    body: unknown,
    retryAfterSeconds: number | null,
    deprecation: { deprecation: string; sunset: string | null } | null,
  ) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : typeof body === "string" && body.length > 0
          ? body.slice(0, 200)
          : "request failed";
    super(`RegulAIt API ${status}: ${detail}`);
    this.name = "RegulAItApiError";
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
    this.deprecation = deprecation;
  }
}

export class BaseClient {
  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  protected readonly fetchImpl: typeof globalThis.fetch;
  protected readonly defaultHeaders: Record<string, string>;

  /**
   * Routes this client called that answered with an RFC-8594 `Deprecation`
   * header, most recent value per route. A long-running integration can log or
   * alert on this rather than discovering a sunset when the route disappears.
   */
  readonly observedDeprecations = new Map<string, { deprecation: string; sunset: string | null }>();

  constructor(options: RegulAItClientOptions) {
    if (!options.baseUrl) throw new Error("baseUrl is required");
    if (!options.apiKey) throw new Error("apiKey is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    const injected = options.fetch ?? globalThis.fetch;
    if (typeof injected !== "function") {
      throw new Error("no fetch implementation available — pass options.fetch");
    }
    this.fetchImpl = injected;
    this.defaultHeaders = options.defaultHeaders ?? {};
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (options?.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined) qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes("?") ? "&" : "?") + s;
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      ...this.defaultHeaders,
      ...(options?.headers ?? {}),
      // last, and deliberately not overridable: a client that lets a caller
      // replace the Authorization header by accident is a client that leaks
      // the wrong credential to the wrong deployment.
      authorization: `Bearer ${this.apiKey}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const res = await this.fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    const deprecationHeader = res.headers.get("deprecation");
    const deprecation = deprecationHeader
      ? { deprecation: deprecationHeader, sunset: res.headers.get("sunset") }
      : null;
    if (deprecation) this.observedDeprecations.set(`${method} ${path}`, deprecation);

    const contentType = res.headers.get("content-type") ?? "";
    const isJson = contentType.includes("json");
    const payload: unknown = isJson
      ? await res.json().catch(() => null)
      : await res.text().catch(() => "");

    if (!res.ok) {
      const retryAfter = res.headers.get("retry-after");
      throw new RegulAItApiError(
        res.status,
        payload,
        retryAfter !== null && retryAfter !== "" ? Number(retryAfter) : null,
        deprecation,
      );
    }
    return payload as T;
  }
}
