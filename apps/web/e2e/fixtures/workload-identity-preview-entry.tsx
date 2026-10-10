/** Test-only Vite HTML entry; not imported by the application or its built index.html. */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../../src/api/client";
import { subscribeStepUpPrompt, type StepUpPrompt } from "../../src/stepup/stepUp";
import { Button, Modal } from "../../src/ui/kit";
import { ToastProvider } from "../../src/ui/toast";
import WorkloadIdentitiesPage from "../../src/views/admin/identity/WorkloadIdentitiesPage";
import type { PutAgentGrants } from "../../../../packages/shared/src/identity/contract";
import { encodeIdentityWrite } from "../../src/views/admin/identity/workloadIdentityApi";
import type { DelegationNode, IdentityAdminPort, IdentityDetail, IdentityInventory, IdentityWrite } from "../../src/views/admin/identity/workloadIdentityModel";
import "../../src/theme/fonts.css";
import "../../src/theme/tokens.css";
import "../../src/theme/global.css";

const mode = new URL(location.href).searchParams.get("mode");
const steward = { id: "00000000-0000-4000-8000-000000000001", name: "Synthetic steward" };
const inventory: IdentityInventory = {
  identities: mode === "empty" ? [] : [{ id: "00000000-0000-4000-8000-000000000003", kind: "agent", identifier: "spiffe://demo.example/regulait/agent/identity-a",
    subjectId: "00000000-0000-4000-8000-000000000004", stewards: [steward], environments: ["demo"], status: "active", createdAt: new Date().toISOString() }],
  people: [steward, { id: "00000000-0000-4000-8000-000000000002", name: "Synthetic co-steward" }],
  subjects: [{ id: "00000000-0000-4000-8000-000000000004", name: "Synthetic agent", kind: "agent" }, { id: "00000000-0000-4000-8000-000000000005", name: "Second synthetic agent", kind: "agent" }],
  environments: ["demo", "byoc"], grantTargets: [
    { id: "00000000-0000-4000-8000-000000000006", name: "Synthetic tool server", kind: "tool", tools: ["read-record", "write-record"] },
    { id: "00000000-0000-4000-8000-000000000007", name: "Synthetic server", kind: "server" }, { id: "00000000-0000-4000-8000-000000000008", name: "Synthetic connector", kind: "connector" },
    { id: "00000000-0000-4000-8000-000000000005", name: "Second synthetic agent", kind: "agent_invoke" }, { id: "00000000-0000-4000-8000-000000000009", name: "Synthetic reader role", kind: "role" },
  ],
};
const details = new Map<string, IdentityDetail>([["00000000-0000-4000-8000-000000000003", { grantsRevision: 0, grants: [], credentials: [{ id: "00000000-0000-4000-8000-000000000010", identityId: "00000000-0000-4000-8000-000000000003", kind: "public_key",
  fingerprint: "synthetic-public-thumbprint", notBefore: new Date(Date.now() - 60000).toISOString(),
  notAfter: new Date(Date.now() + 86400000).toISOString(), revokedAt: null }] }]]);
const tree: DelegationNode[] = [
  { id: "00000000-0000-4000-8000-000000000011", parentId: null, identityId: "00000000-0000-4000-8000-000000000003", identifier: "Root synthetic actor", sponsor: steward, actorChain: ["Root synthetic actor"],
    status: "active", capMicros: "100000000", settledMicros: "10000000", reservedMicros: "50000000", expiresAt: new Date(Date.now() + 300000).toISOString(), allocation: null },
  { id: "00000000-0000-4000-8000-000000000012", parentId: "00000000-0000-4000-8000-000000000011", identityId: "00000000-0000-4000-8000-000000000013", identifier: "Child synthetic actor", sponsor: steward,
    actorChain: ["Root synthetic actor", "Child synthetic actor"], status: "active", capMicros: "60000000", settledMicros: "10000000", reservedMicros: "0", expiresAt: new Date(Date.now() + 300000).toISOString(),
    allocation: { amountMicros: "60000000", drawnMicros: "10000000", releasedMicros: "0", status: "open" } },
];
if (mode === "unknown-budget") tree[1]!.capMicros = null;
if (mode === "unknown-expiry") tree[1]!.expiresAt = "unreadable";
if (mode === "cycle") { tree[0]!.parentId = "00000000-0000-4000-8000-000000000012"; }
const calls: Array<{ command: IdentityWrite; request: ReturnType<typeof encodeIdentityWrite>; headers: Record<string, string> }> = [];
const grants = new Map<string, string>();
let sequence = 0;
const port: IdentityAdminPort = {
  async inventory() { if (mode === "read-error" || (mode === "refresh-read-error" && calls.some(call => call.command.operation === "edit_identity" && !!call.headers["x-regulait-step-up"]))) throw new Error("SYNTHETIC_UNTRUSTED_SERVER_DETAIL"); return structuredClone(inventory); },
  async detail(id) { if (mode === "detail-error") throw new Error("SYNTHETIC_UNTRUSTED_SERVER_DETAIL"); return structuredClone(details.get(id) ?? { grantsRevision: 0, grants: [], credentials: [] }); },
  async delegationTree(runId) { if (mode === "tree-error") throw new Error("SYNTHETIC_UNTRUSTED_SERVER_DETAIL"); return { runId, nodes: structuredClone(tree) }; },
  prepareWrite(command) {
    command = structuredClone(command);
    const snapshot = "identityId" in command ? details.get(command.identityId)?.grants : undefined;
    const request = encodeIdentityWrite(command, snapshot, "identityId" in command ? details.get(command.identityId)?.grantsRevision : undefined);
    return async headers => {
    calls.push({ command: structuredClone(command), request: structuredClone(request), headers: { ...headers } });
    const key = JSON.stringify(request), token = headers["x-regulait-step-up"];
    if (!token || grants.get(token) !== key) throw new ApiError(403, { error: "step_up_required", actionKind: "identity_manage", methods: ["mock"], action: { kind: "identity_manage", body: request } });
    grants.delete(token);
    if (mode === "write-error") throw new ApiError(409, { error: "synthetic_refusal", detail: "SYNTHETIC_UNTRUSTED_SERVER_DETAIL" });
    if (command.operation === "create_identity") {
      const id = `00000000-0000-4000-9000-${String(++sequence).padStart(12, "0")}`;
      inventory.identities.push({ id, kind: command.kind, identifier: `spiffe://demo.example/regulait/${command.kind}/${id}`,
        subjectId: command.subjectId, stewards: inventory.people.filter(p => command.stewardIds.includes(p.id)), environments: command.environments,
        status: "active", createdAt: new Date().toISOString() }); details.set(id, { grantsRevision: 0, grants: [], credentials: [] });
    } else if (command.operation === "edit_identity" || command.operation === "identity_status") {
      const i = inventory.identities.find(i => i.id === command.identityId)!;
      if (command.operation === "identity_status") i.status = command.status;
      else { i.stewards = inventory.people.filter(p => command.stewardIds.includes(p.id)); i.environments = command.environments; }
    } else if (command.operation === "revoke_delegation") {
      const close = (id: string) => {
        const node = tree.find(n => n.id === id)!;
        for (const child of tree.filter(n => n.parentId === id)) close(child.id);
        node.status = "revoked";
        if (node.allocation?.status === "open") {
          const released = BigInt(node.allocation.amountMicros!) - BigInt(node.allocation.drawnMicros!) - BigInt(node.allocation.releasedMicros!);
          node.allocation.status = "closed";
          node.allocation.releasedMicros = String(BigInt(node.allocation.releasedMicros!) + released);
          const parent = tree.find(n => n.id === node.parentId);
          if (parent?.reservedMicros !== null && parent) parent.reservedMicros = String(BigInt(parent.reservedMicros) - released);
        }
      };
      close(command.grantId);
    } else {
      const detail = details.get(command.identityId)!;
      if (command.operation === "revoke_credential") detail.credentials.find(c => c.id === command.credentialId)!.revokedAt = new Date().toISOString();
      else if (command.operation === "add_credential" || command.operation === "rotate_credential") detail.credentials.push({ id: `00000000-0000-4000-a000-${String(++sequence).padStart(12, "0")}`, identityId: command.identityId,
        kind: "public_key", fingerprint: "synthetic-new-public-thumbprint", notBefore: new Date().toISOString(), notAfter: command.notAfter, revokedAt: null });
      else if (command.operation === "add_grant" || command.operation === "remove_grant") {
        const body = request.body as PutAgentGrants, previous = detail.grants;
        if (body.revision !== detail.grantsRevision) throw new ApiError(409, { error: "grants_revision_conflict" });
        detail.grantsRevision++;
        const row = (kind: IdentityDetail["grants"][number]["kind"], targetId: string, toolName: string | null, fields = {}) => ({
          id: previous.find(g => g.kind === kind && g.targetId === targetId && g.toolName === toolName)?.id ?? `own-grant-${++sequence}`,
          kind, targetId, targetName: inventory.grantTargets.find(t => t.id === targetId && t.kind === kind)?.name ?? "Synthetic target", toolName, access: null, ...fields,
        });
        // The synthetic server applies the captured full replacement, including a denial via empty arrays.
        detail.grants = [
          ...body.tools.map(g => row("tool", g.serverId, g.toolName)),
          ...body.servers.map(g => row("server", g.serverId, null, { readOnlyAll: g.readOnlyAll })),
          ...body.agents.map(g => row("agent_invoke", g.agentId, null, { allowedModes: [...g.allowedModes] })),
          ...body.connectors.map(g => row("connector", g.connectorId, null, { mode: g.mode, allowedObjects: [...g.allowedObjects] })),
          ...body.roleIds.map(roleId => row("role", roleId, null)),
        ];
      }
    }
    };
  },
};
declare global { interface Window { identityPreview: { calls: typeof calls; inventory: IdentityInventory; tree: DelegationNode[] } } }
window.identityPreview = { calls, inventory, tree };
function MockStepUp() {
  const [prompt, setPrompt] = useState<StepUpPrompt | null>(null);
  useEffect(() => subscribeStepUpPrompt(setPrompt), []);
  return <Modal open={!!prompt} title="Mock identity management verification" onClose={() => prompt?.finish(null)}
    actions={<><Button onClick={() => prompt?.finish(null)}>Cancel verification</Button><Button variant="primary" onClick={() => {
      if (!prompt) return;
      if (mode === "stale-grant-revision" && (prompt.action.body as { method?: string }).method === "PUT") details.get("00000000-0000-4000-8000-000000000003")!.grantsRevision++;
      const token = `synthetic-step-up-${++sequence}`;
      grants.set(token, JSON.stringify(prompt.action.body)); prompt.finish(token);
    }}>Confirm mock step-up</Button></>}><p>Mock verification only. The requested change is bound to this one-use synthetic grant.</p></Modal>;
}
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(<MemoryRouter><QueryClientProvider client={qc}><ToastProvider>
  <main style={{ maxWidth: 1600, margin: "auto", padding: "var(--s3)" }}><WorkloadIdentitiesPage port={mode === "unavailable" ? undefined : port} preview delegationPreview={mode === "access-unknown" ? undefined : {
    viewerId: mode === "not-steward" ? inventory.people[1]!.id : steward.id,
    projectId: "synthetic-project",
    projectAccess: mode === "no-project-access" ? false : mode === "project-access-unknown" ? null : true,
    uncappedRootAllowed: mode === "cap-relaxed" ? true : mode === "cap-setting-unknown" ? null : false,
    maxLifetimeSeconds: 900,
  }} /></main>
  <MockStepUp />
</ToastProvider></QueryClientProvider></MemoryRouter>);
