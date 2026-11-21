/**
 * ADR-0338 test fixture: a discovered registry agent and an in-memory vendor control (fixtures only, no live tenant).
 * Used by the ADR-0338 suite and the external-effects barrier matrix. Never imported by production code.
 */
import { randomUUID } from "node:crypto";
import { agentRegistryRecords, discoverySources, type Db } from "@regulait/db";
import type { ControlOp, ControlResult, VendorAgentServiceState } from "@regulait/shared";
import type { ControlCredential } from "../vendor-agent-control.js";
import type { VendorAgentControl, VendorAgentRef } from "../vendor-agent-control-contract.js";

/** one disabled `agent_registry_entra` source and one staged agent record on it */
export async function seedRegistryAgent(db: Db, opts: { run: string; createdBy: string; sourceIds: string[] }) {
  const [src] = await db
    .insert(discoverySources)
    .values({ name: `vac-${opts.run}-${randomUUID().slice(0, 8)}`, kind: "agent_registry_entra", target: { tenantId: randomUUID() }, scope: { orgLevel: true, include: [] }, createdBy: opts.createdBy, enabled: false })
    .returning({ id: discoverySources.id });
  opts.sourceIds.push(src!.id);
  const externalId = randomUUID();
  const [rec] = await db
    .insert(agentRegistryRecords)
    .values({ sourceId: src!.id, registry: "entra_agent_id", externalId, displayName: `vac agent ${opts.run}` })
    .returning({ id: agentRegistryRecords.id });
  return { sourceId: src!.id, recordId: rec!.id, externalId };
}

export type FakeBehaviour = "ok" | "timeout" | "refuse" | "noop";

/** an in-memory vendor: `readState` reports what `apply` last set; every apply is recorded */
export function fakeVendorControl() {
  const states = new Map<string, VendorAgentServiceState>();
  const calls: Array<{ op: ControlOp; ref: VendorAgentRef }> = [];
  let behaviour: FakeBehaviour = "ok";
  let unreadable = false;
  const target = (op: ControlOp): VendorAgentServiceState => (op.direction === "reverse" ? "active" : op.action === "disable" ? "disabled" : "quarantined");
  const control: VendorAgentControl = {
    kind: "vendor_agent_control",
    actions: ["disable", "quarantine"],
    async readState(_ctx, ref) {
      if (unreadable) throw new Error("unreadable");
      return { state: states.get(ref.externalId) ?? "active" };
    },
    apply: (_ctx, ref, action) => act(ref, { action, direction: "apply" }),
    reverse: (_ctx, ref, action) => act(ref, { action, direction: "reverse" }),
  };
  async function act(ref: VendorAgentRef, op: ControlOp): Promise<ControlResult> {
    calls.push({ op, ref });
    const want = target(op);
    if (behaviour === "timeout") throw new DOMException("the vendor did not answer", "TimeoutError");
    if (behaviour === "refuse") return { outcome: "refused", code: "vendor_refused_credential", httpStatus: 403 };
    if (behaviour === "noop") return { outcome: "applied", code: "applied", httpStatus: 204 };
    if ((states.get(ref.externalId) ?? "active") === want) return { outcome: "already_in_state", code: "already_in_state", httpStatus: 200 };
    states.set(ref.externalId, want);
    return { outcome: "applied", code: "applied", httpStatus: 204 };
  }
  return {
    control,
    states,
    calls,
    behave(b: FakeBehaviour) {
      behaviour = b;
    },
    unreadable(on: boolean) {
      unreadable = on;
    },
  };
}

/** a credential resolver over a map the test controls (source id → credential); absent means none */
export function fakeCredentials() {
  const creds = new Map<string, ControlCredential>();
  return {
    creds,
    resolver: async (_db: Db, sourceId: string) => creds.get(sourceId) ?? null,
    issue(sourceId: string) {
      const c = { id: randomUUID(), token: `fixture-token-${randomUUID()}` };
      creds.set(sourceId, c);
      return c;
    },
  };
}
