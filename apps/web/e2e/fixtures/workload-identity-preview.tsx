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
import type { DelegationNode, IdentityAdminPort, IdentityDetail, IdentityInventory, IdentityWrite } from "../../src/views/admin/identity/workloadIdentityModel";
import "../../src/theme/fonts.css";
import "../../src/theme/tokens.css";
import "../../src/theme/global.css";

const mode = new URL(location.href).searchParams.get("mode");
const steward = { id: "synthetic-steward", name: "Synthetic steward" };
const inventory: IdentityInventory = {
  identities: mode === "empty" ? [] : [{ id: "identity-a", kind: "agent", identifier: "spiffe://demo.example/regulait/agent/identity-a",
    subjectId: "agent-a", stewards: [steward], environments: ["demo"], status: "active", createdAt: new Date().toISOString() }],
  people: [steward, { id: "co-steward", name: "Synthetic co-steward" }],
  subjects: [{ id: "agent-a", name: "Synthetic agent", kind: "agent" }, { id: "agent-b", name: "Second synthetic agent", kind: "agent" }],
  environments: ["demo", "byoc"], grantTargets: [
    { id: "tools-a", name: "Synthetic tool server", kind: "tool", tools: ["read-record", "write-record"] },
    { id: "server-a", name: "Synthetic server", kind: "server" }, { id: "connector-a", name: "Synthetic connector", kind: "connector" },
    { id: "agent-b", name: "Second synthetic agent", kind: "agent_invoke" }, { id: "role-a", name: "Synthetic reader role", kind: "role" },
  ],
};
const details = new Map<string, IdentityDetail>([["identity-a", { grants: [], credentials: [{ id: "credential-a", identityId: "identity-a", kind: "public_key",
  fingerprint: "synthetic-public-thumbprint", notBefore: new Date(Date.now() - 60000).toISOString(),
  notAfter: new Date(Date.now() + 86400000).toISOString(), revokedAt: null }] }]]);
const tree: DelegationNode[] = [
  { id: "grant-root", parentId: null, identityId: "identity-a", identifier: "Root synthetic actor", sponsor: steward, actorChain: ["Root synthetic actor"],
    status: "active", capMicros: "100000000", settledMicros: "10000000", reservedMicros: "50000000", expiresAt: new Date(Date.now() + 300000).toISOString(), allocation: null },
  { id: "grant-child", parentId: "grant-root", identityId: "child-identity", identifier: "Child synthetic actor", sponsor: steward,
    actorChain: ["Root synthetic actor", "Child synthetic actor"], status: "active", capMicros: "60000000", settledMicros: "10000000", reservedMicros: "0", expiresAt: new Date(Date.now() + 300000).toISOString(),
    allocation: { amountMicros: "60000000", drawnMicros: "10000000", releasedMicros: "0", status: "open" } },
];
if (mode === "unknown-budget") tree[1]!.capMicros = null;
if (mode === "unknown-expiry") tree[1]!.expiresAt = "unreadable";
if (mode === "cycle") { tree[0]!.parentId = "grant-child"; }
const calls: Array<{ command: IdentityWrite; headers: Record<string, string> }> = [];
const grants = new Map<string, string>();
let sequence = 0;
const port: IdentityAdminPort = {
  async inventory() { if (mode === "read-error") throw new Error("SYNTHETIC_UNTRUSTED_SERVER_DETAIL"); return structuredClone(inventory); },
  async detail(id) { if (mode === "detail-error") throw new Error("SYNTHETIC_UNTRUSTED_SERVER_DETAIL"); return structuredClone(details.get(id) ?? { grants: [], credentials: [] }); },
  async delegationTree(runId) { if (mode === "tree-error") throw new Error("SYNTHETIC_UNTRUSTED_SERVER_DETAIL"); return { runId, nodes: structuredClone(tree) }; },
  async write(command, headers) {
    calls.push({ command: structuredClone(command), headers: { ...headers } });
    const key = JSON.stringify(command), token = headers["x-regulait-step-up"];
    if (!token || grants.get(token) !== key) throw new ApiError(403, { error: "step_up_required", actionKind: "identity_manage", methods: ["mock"], action: { kind: "identity_manage", body: command } });
    grants.delete(token);
    if (mode === "write-error") throw new ApiError(409, { error: "synthetic_refusal", detail: "SYNTHETIC_UNTRUSTED_SERVER_DETAIL" });
    if (command.operation === "create_identity") {
      const id = `identity-${++sequence}`;
      inventory.identities.push({ id, kind: command.kind, identifier: `spiffe://demo.example/regulait/${command.kind}/${id}`,
        subjectId: command.subjectId, stewards: inventory.people.filter(p => command.stewardIds.includes(p.id)), environments: command.environments,
        status: "active", createdAt: new Date().toISOString() }); details.set(id, { grants: [], credentials: [] });
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
      else if (command.operation === "add_credential" || command.operation === "rotate_credential") detail.credentials.push({ id: `credential-${++sequence}`, identityId: command.identityId,
        kind: "public_key", fingerprint: "synthetic-new-public-thumbprint", notBefore: new Date().toISOString(), notAfter: command.notAfter, revokedAt: null });
      else if (command.operation === "add_grant") detail.grants.push({ id: `own-grant-${++sequence}`, kind: command.kind, targetId: command.targetId,
        targetName: inventory.grantTargets.find(t => t.id === command.targetId)!.name, toolName: command.toolName, access: command.access });
      else if (command.operation === "remove_grant") detail.grants = detail.grants.filter(g => g.id !== command.grantId);
    }
  },
};
declare global { interface Window { identityPreview: { calls: typeof calls; inventory: IdentityInventory; tree: DelegationNode[] } } }
window.identityPreview = { calls, inventory, tree };
function MockStepUp() {
  const [prompt, setPrompt] = useState<StepUpPrompt | null>(null);
  useEffect(() => subscribeStepUpPrompt(setPrompt), []);
  return <Modal open={!!prompt} title="Mock identity management verification" onClose={() => prompt?.finish(null)}
    actions={<><Button onClick={() => prompt?.finish(null)}>Cancel verification</Button><Button variant="primary" onClick={() => {
      if (!prompt) return; const token = `synthetic-step-up-${++sequence}`;
      grants.set(token, JSON.stringify(prompt.action.body)); prompt.finish(token);
    }}>Confirm mock step-up</Button></>}><p>Mock verification only. The requested change is bound to this one-use synthetic grant.</p></Modal>;
}
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(<MemoryRouter><QueryClientProvider client={qc}><ToastProvider>
  <main style={{ maxWidth: 1600, margin: "auto", padding: "var(--s3)" }}><WorkloadIdentitiesPage port={mode === "unavailable" ? undefined : port} preview /></main>
  <MockStepUp />
</ToastProvider></QueryClientProvider></MemoryRouter>);
