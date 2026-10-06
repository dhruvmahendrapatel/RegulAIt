/**
 * ADR-0181 (strict defaults, batch SB1) — the demo seed's configuration for
 * the GUARDRAILS, DATA AND RUNTIME settings, in one place, called from one line
 * of `seed.ts`.
 *
 * A fresh install now ships these strict: guardrails block prompt injection
 * and jailbreak and warn on the rest, the PII floor is `block`, compliance
 * profiles default to `block` / `read_only`, trace content is NOT captured,
 * the env-key fallback is OFF, and so on. The demo keeps every one of those
 * defaults except where the story genuinely needs something, and each such
 * step goes through the real admin route, is audited, and is printed:
 *
 *   1. PROVIDER KEY. With the env-key fallback off, a provider key in the
 *      environment no longer makes a provider live by itself. When
 *      `GOOGLE_API_KEY` (or its `GEMINI_API_KEY` alias) is set, this imports it
 *      ONCE into the encrypted key store through `POST /v1/model-credentials`
 *      (audited, no key material in the row). A stored Google credential is
 *      never overwritten. The key is never printed, logged or written to a
 *      file; this module reports only "imported", "already stored" or "not
 *      set". Unset, the demo runs on the mock agents exactly as before.
 *
 *   2. TRACE CONTENT CAPTURE — a VISIBLE RELAXATION. Continuous trace
 *      evaluation (ADR-0160) re-runs the detectors over STORED response
 *      previews; with capture off (the strict default) there is nothing to
 *      evaluate and the Monitor beat's "credential in a response" finding
 *      cannot exist. The demo therefore turns capture on through
 *      `PUT /v1/org/settings` (audited old -> new). Credentials are still
 *      scrubbed at write time, and the seed says so when it does it.
 *
 * Everything else stays strict on purpose. The prompt-injection "attempt" in
 * demo:traffic is now REFUSED by the guardrail (the truthful outcome under the
 * strict default), and the PII / read-only MCP posture is what the seeded
 * compliance profiles already declare.
 */
import type { FastifyInstance } from "fastify";
import { ASSURANCE_WINDOW_CREATED_BY } from "./guardrails.js";

type Json = Record<string, unknown>;

export interface StrictDataSeedReport {
  /** what happened to the provider key — never the key itself */
  providerKey: "imported" | "already_stored" | "not_set" | "refused";
  providerKeyDetail?: string;
  traceContentCapture: "enabled" | "already_enabled";
  lines: string[];
}

/** the env names the Google platform key is read from (first non-empty wins),
 * the same convention the dispatch path used for its env fallback */
const GOOGLE_KEY_ENV = ["GOOGLE_API_KEY", "GEMINI_API_KEY"] as const;
const GOOGLE_BASE_ENV = ["GOOGLE_BASE_URL", "GEMINI_BASE_URL"] as const;

function firstSet(env: NodeJS.ProcessEnv, names: readonly string[]): { name: string; value: string } | null {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) return { name, value: value.trim() };
  }
  return null;
}

export async function seedStrictData(
  app: FastifyInstance,
  opts: { bootstrapToken: string; env?: NodeJS.ProcessEnv },
): Promise<StrictDataSeedReport> {
  const env = opts.env ?? process.env;
  const headers = { authorization: `Bearer ${opts.bootstrapToken}` };
  const lines: string[] = [];

  // --- 1. the provider key: env -> encrypted store, once ---------------------
  let providerKey: StrictDataSeedReport["providerKey"];
  let providerKeyDetail: string | undefined;
  const key = firstSet(env, GOOGLE_KEY_ENV);
  if (!key) {
    providerKey = "not_set";
    lines.push("provider key: GOOGLE_API_KEY is not set — the demo runs on the mock agents");
  } else {
    const listed = await app.inject({ method: "GET", url: "/v1/model-credentials", headers });
    const stored = ((listed.json() as Json).credentials as Array<{ provider: string }> | undefined) ?? [];
    if (stored.some((c) => c.provider === "google")) {
      providerKey = "already_stored";
      lines.push("provider key: a Google credential is already in the encrypted store — left unchanged");
    } else {
      const base = firstSet(env, GOOGLE_BASE_ENV);
      const res = await app.inject({
        method: "POST",
        url: "/v1/model-credentials",
        headers,
        payload: { provider: "google", apiKey: key.value, ...(base ? { baseUrl: base.value } : {}) },
      });
      if (res.statusCode === 201) {
        providerKey = "imported";
        lines.push(
          `provider key: imported ${key.name} from the environment into the encrypted key store ` +
            `(provider 'google', audited; the value is never printed or stored in the clear)`,
        );
      } else {
        // the error CODE only — a validation body could echo request fields
        let code = `HTTP ${res.statusCode}`;
        try {
          const e = (res.json() as Json).error;
          if (typeof e === "string") code = e;
        } catch {
          /* not JSON */
        }
        providerKey = "refused";
        providerKeyDetail = code;
        lines.push(`provider key: the key store refused the import (${code}) — the demo runs on the mock agents`);
      }
    }
  }

  // --- 2. trace content capture: a visible, audited relaxation ---------------
  const settings = ((await app.inject({ method: "GET", url: "/v1/org/settings", headers })).json() as Json)
    .settings as Json | undefined;
  let traceContentCapture: StrictDataSeedReport["traceContentCapture"];
  if (settings?.tracingCaptureContent === true) {
    traceContentCapture = "already_enabled";
  } else {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/org/settings",
      headers,
      payload: { tracingCaptureContent: true },
    });
    if (res.statusCode !== 200) {
      throw new Error(`PUT /v1/org/settings (tracingCaptureContent) -> ${res.statusCode}: ${res.body}`);
    }
    traceContentCapture = "enabled";
  }
  lines.push(
    "RELAXED for the demo: trace content capture is ON (strict default: off) so continuous trace " +
      "evaluation has stored previews to evaluate; credentials are still scrubbed at write time. " +
      "Audited in /admin -> Audit (org-settings-updated).",
  );

  return { providerKey, ...(providerKeyDetail ? { providerKeyDetail } : {}), traceContentCapture, lines };
}

type InjectCall = (
  method: string,
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number; body: Record<string, any> }>;

/** ADR-0181 FX3: the window asks the server for this long — the assurance
 * run's budget. The server caps a window at ASSURANCE_WINDOW_MAX_MINUTES,
 * ignores it once past and deletes it (audited) in the expiry sweep. */
export const ASSURANCE_WINDOW_TTL_MINUTES = 30;

type Mode = "off" | "log" | "warn" | "block";
/** the two layers the window relaxes, and only from `block` to `warn` */
const WINDOW_LAYERS = ["prompt_injection", "jailbreak"] as const;
const CONFIGURABLE_LAYERS = ["prompt_injection", "jailbreak", "toxicity", "semantic_dlp"] as const;

/**
 * ADR-0181 x ADR-0180 — THE ASSURANCE RUN'S GUARDRAIL WINDOW.
 *
 * A required AI test is evidence about the AGENT: ADR-0180 counts only probe
 * trials that reached it, and a trial the platform held is excluded. Under the
 * strict default the org guardrail BLOCKS prompt injection and jailbreak at
 * the input, so every probe of those classes is held before it reaches the
 * agent and the run measures nothing about the agent. To measure the agent,
 * the demo opens a WINDOW: for each agent under test that has no admin
 * guardrail override of its own, it sets an agent-scope override through
 * `PUT /v1/guardrails/config/agent/:id` (audited old -> new) that
 *
 *   - COPIES the org default's modes and relaxes only prompt injection and
 *     jailbreak, from `block` to `warn` (toxicity and semantic DLP stay exactly
 *     as the org has them);
 *   - is a server-side WINDOW (ADR-0181 FX3): tagged `assurance-window`, with
 *     an expiry `ASSURANCE_WINDOW_TTL_MINUTES` from now. The resolver ignores
 *     it once expired and the scheduler's expiry sweep deletes it (audited), so
 *     a crash between open and close cannot leave a permanent relaxation.
 *
 * It runs the suite, and `restore()` removes exactly the overrides it opened
 * (`DELETE`, audited), so the strict org default applies again at once. A
 * re-run RECLAIMS its own leftover window rows (a crashed earlier run); an
 * override an admin set is never touched. The guardrail is not part of an
 * agent's configuration hash, so the run stays evidence for the configuration
 * shipped.
 */
export async function openAssuranceGuardrailWindow(
  call: InjectCall,
  auth: Record<string, string>,
  agentIds: readonly string[],
): Promise<{ opened: string[]; notes: string[]; restore: () => Promise<string[]> }> {
  const config = (await call("GET", "/v1/guardrails/config", undefined, auth)).body;
  const orgModes = (config.orgModes ?? {}) as Record<string, Mode>;
  const overrides = new Map(
    ((config.overrides ?? []) as Array<{ scope: string; scopeId: string; createdBy?: string }>)
      .filter((o) => o.scope === "agent")
      .map((o) => [o.scopeId, o]),
  );
  // the org's own modes for the four configurable layers (PII is the cascade's,
  // never written here), with ONLY the two probe layers relaxed block -> warn
  const modes: Record<string, Mode> = {};
  for (const layer of CONFIGURABLE_LAYERS) if (orgModes[layer]) modes[layer] = orgModes[layer];
  for (const layer of WINDOW_LAYERS) if (modes[layer] === "block") modes[layer] = "warn";
  const relaxes = WINDOW_LAYERS.some((l) => orgModes[l] === "block");
  const opened: string[] = [];
  const notes: string[] = [];
  let reclaimed = 0;
  for (const id of new Set(agentIds)) {
    const existing = overrides.get(id);
    const leftover = existing?.createdBy === ASSURANCE_WINDOW_CREATED_BY;
    if (existing && !leftover) {
      notes.push(`assurance guardrail window: agent ${id} has an admin guardrail override — left as set`);
      continue;
    }
    if (!relaxes && !leftover) continue; // the org default already lets the probes reach the agent
    const r = await call(
      "PUT",
      `/v1/guardrails/config/agent/${id}`,
      { modes, assuranceWindow: { ttlMinutes: ASSURANCE_WINDOW_TTL_MINUTES } },
      auth,
    );
    if (r.status === 200) {
      opened.push(id);
      if (leftover) reclaimed++;
    } else notes.push(`assurance guardrail window: could not open for agent ${id} (${r.status} ${String(r.body.error ?? "")})`);
  }
  if (reclaimed > 0) {
    notes.push(`assurance guardrail window: reclaimed ${reclaimed} leftover window override(s) from an earlier run`);
  }
  if (opened.length > 0 && relaxes) {
    notes.push(
      `RELAXED for the assurance run only: prompt-injection and jailbreak guardrails at 'warn' (strict default: block) ` +
        `on ${opened.length} agent(s) under test, so the probes reach the agent; the other layers keep the org's modes. ` +
        `The window expires on the server after ${ASSURANCE_WINDOW_TTL_MINUTES} minutes and is restored when the run ends (both audited)`,
    );
  }
  const restore = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const id of opened) {
      const d = await call("DELETE", `/v1/guardrails/config/agent/${id}`, undefined, auth);
      if (d.status !== 200) {
        out.push(
          `assurance guardrail window: could not close for agent ${id} (${d.status}); it expires on the server within ` +
            `${ASSURANCE_WINDOW_TTL_MINUTES} minutes and the expiry sweep removes it`,
        );
      }
    }
    return out;
  };
  return { opened, notes, restore };
}
