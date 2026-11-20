/**
 * ADR-0303 — SIEM delivery of the audit chain, as pure functions for the "SIEM delivery" page
 * (`GET/POST /v1/siem/destinations`, `PUT …/:id/enabled`, `POST …/:id/rotate-secret`, `POST …/:id/recover`).
 *
 * A destination is an acknowledged outbox over the hash-chained audit log: batches go out signed (Standard Webhooks)
 * and the cursor moves only when the receiver answers 2xx. A destination is created OFF; turning it on is a
 * relaxation (a `settings_relax` step-up), and so is rotating its secret. After repeated failures it is dead-lettered
 * and waits for an admin to recover it. The gateway keeps only a fixed error code, never the receiver's text.
 *
 * The page reads `kind` rather than assuming webhooks: ADR-0351 adds syslog-over-TLS destinations, which have no secret.
 */
import type { Tone } from "../../../ui/kit";

export type SiemState = "active" | "backoff" | "dead_letter";

export interface SiemDestination {
  id: string;
  name: string;
  kind: string;
  url: string;
  allowPlaintextHttp: boolean;
  enabled: boolean;
  state: SiemState;
  cursorSeq: number | string;
  lag: number;
  consecutiveFailures: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  deliveredEvents: number;
  secretRotatedAt: string | null;
  createdAt: string;
}

export interface SiemList {
  destinations: SiemDestination[];
  headSeq: number | string;
  envelope?: { schema: string; fields: string[]; note?: string };
}

/** what the row shows: on or off first, then how delivery is going */
export function deliveryState(d: SiemDestination): { label: string; tone: Tone } {
  if (!d.enabled) return { label: "Off", tone: "neutral" };
  if (d.state === "dead_letter") return { label: "Stopped after failures", tone: "danger" };
  if (d.state === "backoff") return { label: "Retrying", tone: "warn" };
  return { label: "Delivering", tone: "ok" };
}

const ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  http_4xx: "The receiver refused the batch (4xx).",
  http_408: "The receiver timed out the request (408).",
  http_413: "The receiver said the batch was too large (413).",
  http_429: "The receiver asked to slow down (429).",
  http_5xx: "The receiver failed (5xx).",
  timeout: "The receiver did not answer in time.",
  network: "The receiver could not be reached.",
  egress_blocked: "The host is not on this deployment's egress allow-list.",
  no_data_key: "This deployment has no data key, so the signing secret cannot be read.",
  secret_unreadable: "The signing secret could not be decrypted.",
  tls_handshake: "The TLS handshake with the receiver failed.",
});

/** the stored error code in plain words; an unknown code is shown as itself */
export function errorText(code: string | null): string | null {
  if (!code) return null;
  return ERROR_TEXT[code] ?? `Last error: ${code}.`;
}

/** what each row action may do now, and why not when it may not */
export function rowActions(d: SiemDestination): {
  recover: string | null;
  rotate: string | null;
} {
  return {
    recover: d.state === "active" ? "Delivery is not stopped or retrying, so there is nothing to recover." : null,
    rotate: d.kind !== "webhook" ? "Only a webhook destination has a signing secret." : null,
  };
}

export interface CreateDraft {
  name: string;
  url: string;
  allowPlaintextHttp: boolean;
  startFrom: "now" | "beginning";
}

export const EMPTY_DRAFT: CreateDraft = { name: "", url: "", allowPlaintextHttp: false, startFrom: "now" };

/** the browser-side checks; the gateway checks again and decides egress at send time */
export function createProblems(d: CreateDraft): { name?: string; url?: string } {
  const out: { name?: string; url?: string } = {};
  const name = d.name.trim();
  if (!name) out.name = "Give the destination a name.";
  else if (name.length > 120) out.name = "Keep the name to 120 characters.";
  const raw = d.url.trim();
  let u: URL | null = null;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }
  if (!raw) out.url = "Enter the receiver's URL.";
  else if (raw.length > 2048) out.url = "Keep the URL to 2,048 characters.";
  else if (!u) out.url = "Enter a full URL, starting with https://.";
  else if (u.protocol === "http:" && !d.allowPlaintextHttp) out.url = "Use https://, or allow plain http below for a receiver inside your network.";
  else if (u.protocol !== "https:" && u.protocol !== "http:") out.url = "Only https:// (or allowed http://) is supported here.";
  else if (u.username || u.password) out.url = "Leave credentials out of the URL.";
  else if (u.hash) out.url = "Leave the #fragment out of the URL.";
  return out;
}

export function createBody(d: CreateDraft) {
  return {
    name: d.name.trim(),
    url: d.url.trim(),
    ...(d.allowPlaintextHttp ? { allowPlaintextHttp: true } : {}),
    ...(d.startFrom === "beginning" ? { startFrom: "beginning" as const } : {}),
  };
}

export const SIEM_STORED_NOTE =
  "Give it to the receiver to verify signatures with any Standard Webhooks library. It is stored encrypted under this deployment's data key and is not shown again; rotate it to get a new one.";

export const SIEM_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  destination_name_taken: "A destination with that name already exists. Names are unique, ignoring case.",
  invalid_url: "The gateway refused that URL.",
  no_data_key: "This deployment has no data key, so it cannot keep a signing secret yet.",
  not_found: "That destination no longer exists.",
  not_applicable: "This destination has no signing secret to rotate.",
});
