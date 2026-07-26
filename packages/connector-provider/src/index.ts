/**
 * @regulait/connector-provider — the real execution layer behind pillar 1's
 * connector catalog (GOVERNANCE §2) and pillar 5's actual-spend ledger
 * (GOVERNANCE §10.3).
 *
 * Follows the git-provider/pm-provider/model-provider playbook: a neutral
 * interface, real adapters for the kinds we implement now (a generic
 * HTTP/REST connector and a signed webhook receiver, both with injectable
 * fetch), an in-memory mock for tests and air-gapped development, and a
 * registry whose switch stays exhaustive over the kind union — a future new
 * kind forces a compile error instead of a silent promise.
 *
 * Placement rule (GOVERNANCE §7): execution always runs strictly AFTER the
 * governance decision, inside the `allow` branch. This package never decides
 * whether a call is permitted — it is handed an already-authorized operation
 * and performs exactly that. A FAILED call surfaces as a ConnectorProviderError
 * and bills nothing (the gateway mirrors the model path).
 *
 * "No silent promises" rule (same as model-provider): kinds that are
 * interface-ready but not implemented (slack/github/jira/snowflake) throw an
 * explicit "not implemented yet" from the registry rather than pretending.
 */

import { z } from "zod";

export const CONNECTOR_PROVIDER_KINDS = [
  "http",
  "webhook",
  "slack",
  "github",
  "jira",
  "snowflake",
  "generic",
  "mock",
] as const;
export type ConnectorProviderKind = (typeof CONNECTOR_PROVIDER_KINDS)[number];

export function isConnectorProviderKind(value: string): value is ConnectorProviderKind {
  return (CONNECTOR_PROVIDER_KINDS as readonly string[]).includes(value);
}

export class ConnectorProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** A single governed connector call: read fetches the named object, write
 * pushes the payload to it. `object` and `payload` are optional — a bare
 * read/write against the connection root is valid. */
export interface ConnectorInvocation {
  operation: "read" | "write";
  object?: string | null;
  payload?: Record<string, unknown> | null;
}

/** The neutral result every adapter returns: the upstream status and its
 * decoded body. The gateway ledgers cost against the connector's list price,
 * never against anything in here. */
export interface ConnectorInvokeResult {
  status: number;
  body: unknown;
}

export interface ConnectorProvider {
  readonly kind: ConnectorProviderKind;
  invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult>;
}

// The same injectable-fetch shape the pm-provider adapters use, so unit tests
// never touch the network.
type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

// ---------------------------------------------------------------------------
// Generic HTTP/REST adapter — serves both the "generic" and "http" kinds.
// A read is GET {baseUrl}/{object}; a write is POST {baseUrl}/{object} with the
// payload as a JSON body. An optional bearer token authenticates. Any non-2xx
// surfaces as a ConnectorProviderError carrying the status (a failed call bills
// nothing upstream in the gateway).
// ---------------------------------------------------------------------------

export interface GenericHttpAdapterOptions {
  /** the connection root, e.g. https://api.example.com/v1 */
  baseUrl: string;
  /** optional bearer credential; absent = an unauthenticated endpoint */
  token?: string | null;
  fetchImpl?: FetchLike;
}

export class GenericHttpConnectorProvider implements ConnectorProvider {
  readonly kind: ConnectorProviderKind;
  private readonly base: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(kind: "generic" | "http", opts: GenericHttpAdapterOptions) {
    this.kind = kind;
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private url(object?: string | null): string {
    const path = object ? `/${String(object).replace(/^\//, "")}` : "";
    return `${this.base}${path}`;
  }

  private headers(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json" };
    if (withBody) h["content-type"] = "application/json";
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const url = this.url(invocation.object);
    const res =
      invocation.operation === "write"
        ? await this.fetchImpl(url, {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify(invocation.payload ?? {}),
          })
        : await this.fetchImpl(url, { method: "GET", headers: this.headers(false) });
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorProviderError(
        `${this.kind} ${invocation.operation} ${url} failed: ${await res.text()}`,
        res.status,
      );
    }
    // a non-JSON 2xx body carries no structured data — surface null, not a throw
    const text = await res.text();
    if (!text) return { status: res.status, body: null };
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook adapter — POSTs one normalized envelope { operation, object,
// timestamp, payload } to the connection's baseUrl (the outbound mirror of the
// pm-provider's generic webhook). The token, when present, is sent as a bearer
// credential. Any non-2xx surfaces as a ConnectorProviderError.
// ---------------------------------------------------------------------------

export interface WebhookAdapterOptions {
  baseUrl: string;
  token?: string | null;
  fetchImpl?: FetchLike;
}

export class WebhookConnectorProvider implements ConnectorProvider {
  readonly kind = "webhook" as const;
  private readonly url: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(opts: WebhookAdapterOptions) {
    // the baseUrl IS the receiver endpoint — nothing is appended
    this.url = opts.baseUrl;
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const body = JSON.stringify({
      operation: invocation.operation,
      object: invocation.object ?? null,
      timestamp: new Date().toISOString(),
      payload: invocation.payload ?? {},
    });
    const res = await this.fetchImpl(this.url, { method: "POST", headers, body });
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorProviderError(
        `webhook ${invocation.operation} failed: ${await res.text()}`,
        res.status,
      );
    }
    const text = await res.text();
    if (!text) return { status: res.status, body: null };
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  }
}

// ---------------------------------------------------------------------------
// Mock adapter — in-memory, keyless, deterministic: for tests and air-gapped
// development. `read` returns a canned object keyed by the requested object;
// `write` records the payload and echoes it back. The whole execution layer is
// demoable and testable with zero external keys and zero network.
// ---------------------------------------------------------------------------

export class MockConnectorProvider implements ConnectorProvider {
  readonly kind = "mock" as const;
  /** every write, in order — inspectable by tests */
  readonly writes: Array<{ object: string | null; payload: Record<string, unknown> }> = [];

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const object = invocation.object ?? null;
    if (invocation.operation === "write") {
      const payload = invocation.payload ?? {};
      this.writes.push({ object, payload });
      return { status: 200, body: { ok: true, operation: "write", object, echoed: payload } };
    }
    // deterministic canned read — a stable shape keyed by the object name so a
    // demo/test can assert an exact body with no external system
    return {
      status: 200,
      body: {
        object: object ?? "root",
        records: [
          { id: `${object ?? "root"}-1`, name: `mock ${object ?? "root"} #1` },
          { id: `${object ?? "root"}-2`, name: `mock ${object ?? "root"} #2` },
        ],
        source: "mock-connector",
      },
    };
  }

  /** test helper: forget every recorded write */
  reset(): void {
    this.writes.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ConnectorProviderConfig {
  kind: ConnectorProviderKind;
  /** connection root / receiver endpoint; required for generic/http/webhook */
  baseUrl?: string | null;
  /** bearer credential; keyless kinds (mock, unauthenticated generic) omit it */
  token?: string | null;
}

/** validates the persisted provider config before an adapter is built */
export const connectorProviderConfigSchema = z.object({
  kind: z.enum(CONNECTOR_PROVIDER_KINDS),
  baseUrl: z.string().url().nullable().optional(),
  token: z.string().min(1).nullable().optional(),
});

/** shared mock instance so recorded writes persist across resolutions in one
 * process (mirrors pm-provider's sharedMock) */
const sharedMock = new MockConnectorProvider();

export function resolveConnectorProvider(
  config: ConnectorProviderConfig,
  fetchImpl?: FetchLike,
): ConnectorProvider {
  switch (config.kind) {
    case "mock":
      return sharedMock;
    case "generic":
    case "http": {
      if (!config.baseUrl) {
        throw new ConnectorProviderError(
          `${config.kind} connector requires a baseUrl (the connection root URL)`,
        );
      }
      return new GenericHttpConnectorProvider(config.kind, {
        baseUrl: config.baseUrl,
        token: config.token ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    }
    case "webhook":
      if (!config.baseUrl) {
        throw new ConnectorProviderError(
          "webhook connector requires a baseUrl (the receiver endpoint URL)",
        );
      }
      return new WebhookConnectorProvider({
        baseUrl: config.baseUrl,
        token: config.token ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    // Declared, interface-ready, but not built yet — an explicit failure, never
    // a silent success (the model-provider discipline).
    case "slack":
    case "github":
    case "jira":
    case "snowflake":
      throw new ConnectorProviderError(
        `connector kind '${config.kind}' is not implemented yet`,
        501,
      );
  }
}
