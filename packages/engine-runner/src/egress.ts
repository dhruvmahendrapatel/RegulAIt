/**
 * ADR-0187 — THE EGRESS PROBE a runner runs inside its own container, as part
 * of its self-test. The engines network is `internal: true`, so from inside a
 * correctly deployed runner an external host must neither RESOLVE nor
 * CONNECT. Either one succeeding means the runner can reach beyond the gateway,
 * and the self-test fails (the gateway then refuses to enable the engine).
 *
 * Two independent checks, because a blocked resolver alone proves nothing
 * about IP egress: (1) DNS resolution of the probe host; (2) a TCP connect, to
 * the probe host by name and, when one is configured, to a literal address
 * (which needs no resolver at all). FAIL CLOSED: only the errors an
 * internal network produces (no route, no resolver, a timeout) count as
 * "denied"; any other outcome, including a refusal or a reset from the far end
 * (something answered), counts as "reached".
 *
 * Stdlib only (node:dns, node:net): nothing to admit under ADR-0176.
 */
import { promises as dnsPromises } from "node:dns";
import { connect as netConnect, type Socket } from "node:net";

export interface EgressProbeOptions {
  /** an external host name (default: example.com) */
  host?: string;
  /** a literal external address to connect to without a resolver (optional) */
  ip?: string | null;
  port?: number;
  timeoutMs?: number;
  /** seams for tests */
  lookup?: (host: string) => Promise<unknown>;
  connect?: (host: string, port: number, timeoutMs: number) => Promise<"connected" | "denied">;
}

export interface EgressProbeResult {
  host: string;
  dnsResolved: boolean;
  connected: boolean;
}

/** resolver errors that mean "no answer came from outside" */
const DNS_DENIED_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EAI_FAIL",
  "ESERVFAIL",
  "ENODATA",
  "ECONNREFUSED",
  "ETIMEOUT",
  "ETIMEDOUT",
]);
/** connect errors that mean "no packet got out" (a refusal or reset means something answered) */
const CONNECT_DENIED_CODES = new Set(["ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "EPERM", "EACCES", "ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL"]);

/** a TCP connect with a hard timeout; "connected" only on an established socket */
export function tcpConnect(host: string, port: number, timeoutMs: number): Promise<"connected" | "denied"> {
  return new Promise((resolve) => {
    let done = false;
    let socket: Socket | null = null;
    const finish = (r: "connected" | "denied") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish("denied"), timeoutMs);
    try {
      socket = netConnect({ host, port });
      socket.once("connect", () => finish("connected"));
      socket.once("error", (e: NodeJS.ErrnoException) => finish(CONNECT_DENIED_CODES.has(e.code ?? "") ? "denied" : "connected"));
    } catch {
      finish("denied");
    }
  });
}

async function resolves(lookup: (h: string) => Promise<unknown>, host: string, timeoutMs: number): Promise<boolean> {
  try {
    await Promise.race([
      lookup(host),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), timeoutMs).unref()),
    ]);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? "";
    // fail closed: an unexplained failure is not evidence that egress is denied
    return !DNS_DENIED_CODES.has(code);
  }
}

/** run the probe; every field true means "this reached out" */
export async function probeEgress(opts: EgressProbeOptions = {}): Promise<EgressProbeResult> {
  const host = opts.host ?? "example.com";
  const port = opts.port ?? 443;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const lookup = opts.lookup ?? ((h: string) => dnsPromises.lookup(h));
  const connect = opts.connect ?? tcpConnect;
  const dnsResolved = await resolves(lookup, host, timeoutMs);
  let connected = (await connect(host, port, timeoutMs)) === "connected";
  if (!connected && opts.ip) connected = (await connect(opts.ip, port, timeoutMs)) === "connected";
  return { host, dnsResolved, connected };
}
