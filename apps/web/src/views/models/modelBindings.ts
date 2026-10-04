/**
 * ADR-0172 — the one place a governed model binding (a row in the agent
 * registry) becomes a tile: provider label, logo key, tier and READINESS.
 *
 * Readiness is computed from data the console already reads — nothing new is
 * asked of the gateway:
 *  - the binding itself (enabled, haltedAt, lifecycleStatus, model, and for a
 *    person's own list the `revoked` flag) — admins read the full registry
 *    (GET /v1/agents); everyone else reads their grants
 *    (GET /v1/users/:me/agents), which carries no halt/lifecycle columns, so a
 *    halted or suspended binding shows as ready there and the Run refuses it
 *    by name instead;
 *  - GET /v1/model-providers/status (platform credential or env fallback) plus
 *    the person's own stored keys, which make a provider callable for them.
 *
 * Pure functions only, so the rules are unit-tested without a browser.
 */
import { providerLabel as fmtProviderLabel } from "../../api/format";
import type { ModelPickerAgent } from "../../ui/ModelPicker";
import type { Tone } from "../../ui/kit";
import { providerLogoKey } from "../../ui/logos/providerLogo";

export type Readiness =
  | "ready"
  | "needs_credentials"
  | "halted"
  | "suspended"
  | "retired"
  | "disabled"
  | "revoked"
  | "routing_only";

export const READINESS: Record<Readiness, { label: string; tone: Tone }> = {
  ready: { label: "Ready", tone: "ok" },
  needs_credentials: { label: "Needs credentials", tone: "warn" },
  halted: { label: "Halted", tone: "danger" },
  suspended: { label: "Suspended", tone: "danger" },
  retired: { label: "Retired", tone: "neutral" },
  disabled: { label: "Disabled", tone: "neutral" },
  revoked: { label: "Access revoked", tone: "danger" },
  routing_only: { label: "Routing only", tone: "neutral" },
};

/** the minimum a binding row carries, from either list */
export interface BindingRow {
  id: string;
  name: string;
  provider: string;
  model?: string | null;
  tier: number;
  enabled?: boolean;
  haltedAt?: string | null;
  haltedReason?: string | null;
  lifecycleStatus?: string;
  lifecycleReason?: string | null;
  revoked?: boolean;
  customProviderId?: string | null;
}

export interface ReadinessContext {
  /** GET /v1/model-providers/status → providers */
  providerStatus: Record<string, { configured: boolean }>;
  /** providers the signed-in person has stored their own key for */
  myProviders: readonly string[];
}

export interface ModelBinding extends ModelPickerAgent {
  readiness: Readiness;
  /** one sentence on why the badge says what it says */
  readinessDetail: string;
}

/** a provider kind as people read it ("openai" → "OpenAI"), shared with the rest of the console */
export function providerLabel(provider: string): string {
  if (provider === "custom") return "Custom endpoint";
  return provider ? fmtProviderLabel(provider) : "Unknown";
}

/** the readiness of one binding for the person looking at it, with its reason */
export function readinessOf(row: BindingRow, ctx: ReadinessContext): { readiness: Readiness; detail: string } {
  const provider = providerLabel(row.provider);
  if (row.revoked) {
    return { readiness: "revoked", detail: "Your access to this model was revoked by an admin." };
  }
  if (row.haltedAt) {
    return {
      readiness: "halted",
      detail: `Halted by an operator${row.haltedReason ? `: ${row.haltedReason}` : ""} — every call refuses until the halt is lifted.`,
    };
  }
  if (row.lifecycleStatus === "retired") {
    return { readiness: "retired", detail: "Retired — this binding no longer accepts calls." };
  }
  if (row.lifecycleStatus === "suspended") {
    return {
      readiness: "suspended",
      detail: `Suspended${row.lifecycleReason ? `: ${row.lifecycleReason}` : ""} — calls refuse until an admin returns it to service.`,
    };
  }
  if (row.enabled === false) {
    return { readiness: "disabled", detail: "Disabled in the agent registry — calls refuse until an admin enables it." };
  }
  if (!row.model) {
    return {
      readiness: "routing_only",
      detail: "No model id is set, so this binding takes part in routing decisions but cannot be called directly.",
    };
  }
  if (row.provider === "mock") {
    return { readiness: "ready", detail: "Simulated replies — no credential needed and every call costs $0." };
  }
  if (row.provider === "custom") {
    return { readiness: "ready", detail: "Runs on a custom endpoint, with that endpoint's own connection settings." };
  }
  if (ctx.myProviders.includes(row.provider)) {
    return { readiness: "ready", detail: `Runs on your own ${provider} key.` };
  }
  if (ctx.providerStatus[row.provider]?.configured) {
    return { readiness: "ready", detail: `Runs on the platform ${provider} credential.` };
  }
  return {
    readiness: "needs_credentials",
    detail: `No ${provider} credential is configured yet, so calls to this model will be refused. Add your own key, or ask an admin to add the platform credential.`,
  };
}

export function toBinding(row: BindingRow, ctx: ReadinessContext): ModelBinding {
  const r = readinessOf(row, ctx);
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    providerLabel: providerLabel(row.provider),
    model: row.model ?? null,
    tier: row.tier,
    logoKey: providerLogoKey(row.provider),
    readiness: r.readiness,
    readinessDetail: r.detail,
    readinessLabel: READINESS[r.readiness].label,
    readinessTone: READINESS[r.readiness].tone,
  };
}

/** GET /v1/users/:me/agents rows (agentId, not id) → bindings; sorted by name */
export function bindingsFromGranted(
  rows: ReadonlyArray<{ agentId: string; name: string; provider: string; model?: string | null; tier: number; enabled?: boolean; revoked?: boolean }>,
  ctx: ReadinessContext,
): ModelBinding[] {
  return rows
    .map((r) => toBinding({ ...r, id: r.agentId }, ctx))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** GET /v1/agents rows → bindings; sorted by name */
export function bindingsFromRegistry(rows: ReadonlyArray<BindingRow>, ctx: ReadinessContext): ModelBinding[] {
  return rows.map((r) => toBinding(r, ctx)).sort((a, b) => a.name.localeCompare(b.name));
}

/** search (name, model id, provider) and provider-chip filter */
export function filterBindings<T extends ModelPickerAgent>(list: readonly T[], query: string, provider: string | null): T[] {
  const q = query.trim().toLowerCase();
  return list.filter((b) => {
    if (provider && b.provider !== provider) return false;
    if (!q) return true;
    return [b.name, b.model ?? "", b.provider, b.providerLabel].some((f) => f.toLowerCase().includes(q));
  });
}

/** the provider chips: each provider present, with its count, in label order */
export function providerChips(list: readonly ModelPickerAgent[]): Array<{ provider: string; label: string; logoKey: string | null; count: number }> {
  const by = new Map<string, { provider: string; label: string; logoKey: string | null; count: number }>();
  for (const b of list) {
    const cur = by.get(b.provider);
    if (cur) cur.count += 1;
    else by.set(b.provider, { provider: b.provider, label: b.providerLabel, logoKey: b.logoKey, count: 1 });
  }
  return [...by.values()].sort((a, b) => a.label.localeCompare(b.label));
}
