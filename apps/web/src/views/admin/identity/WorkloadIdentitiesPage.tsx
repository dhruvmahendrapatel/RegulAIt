import { IDENTITY_STRICT_DEFAULTS, IDENTITY_SETTING_LIMITS } from "../../../../../../packages/shared/src/identity/settings";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../../../shell/AppShell";
import { withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, ErrorState, Field, Input, Modal, Select, SkeletonBlock, Table } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import {
  credentialStatus, formatMicros, orderedDelegations, publicKeyFingerprint, readPublicKey, remainingMicros,
  validateIdentity, workloadKindLabels, ownGrantSummary, canPreviewDelegation, validateRootDelegationPreview, delegationRefusalMessages, type DelegationPreviewContext, type IdentityAdminPort, type IdentityInventory, type IdentityWrite,
  type OwnGrant, type PublicKey, type WorkloadCredential, type WorkloadIdentity, type WorkloadKind,
} from "./workloadIdentityModel";
import s from "./workloadIdentities.module.css";

const queryRoot = ["admin", "workload-identities"] as const;
type Form = { kind: "identity"; identity?: WorkloadIdentity } |
  { kind: "credential"; identity: WorkloadIdentity; previous?: WorkloadCredential } |
  { kind: "grant"; identity: WorkloadIdentity };
type Confirmation = { title: string; body: string; label: string; command: IdentityWrite };
const dateLabel = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Unmeasured";

/** S6 view components. Shared S1 schemas define writes; read envelopes await the S6 server contract. */
export default function WorkloadIdentitiesPage({ port, preview = false, delegationPreview }: { port?: IdentityAdminPort; preview?: boolean; delegationPreview?: DelegationPreviewContext }) {
  const qc = useQueryClient(), { toast } = useToast();
  const [delegationOpen, setDelegationOpen] = useState(false);
  const [delegationResult, setDelegationResult] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const [runInput, setRunInput] = useState(""), [runId, setRunId] = useState<string | null>(null);
  const [at, setAt] = useState(Date.now());
  const inventory = useQuery({ queryKey: [...queryRoot, "inventory"], queryFn: () => port!.inventory(), enabled: !!port });
  const identity = inventory.data?.identities.find(i => i.id === selectedId);
  const detail = useQuery({ queryKey: [...queryRoot, "detail", selectedId], queryFn: () => port!.detail(selectedId!), enabled: !!port && !!identity });
  const tree = useQuery({ queryKey: [...queryRoot, "tree", runId], queryFn: () => port!.delegationTree(runId!), enabled: !!port && !!runId });
  const ordered = tree.data ? orderedDelegations(tree.data.nodes) : null;
  useEffect(() => { const timer = setInterval(() => setAt(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (selectedId && inventory.data && !inventory.data.identities.some(i => i.id === selectedId)) {
      setSelectedId(null); setForm(null); setConfirmation(null);
    }
  }, [inventory.data, selectedId]);
  async function write(command: IdentityWrite) {
    if (!port || busy) return;
    setBusy(true); setFailure(null);
    try {
      // The captured command is identical on retry; the server binds identity_manage to it.
      const capturedWrite = port.prepareWrite(command);
      await withStepUp(capturedWrite);
      await qc.invalidateQueries({ queryKey: queryRoot });
      toast("Workload identity change recorded.", "success");
    } catch {
      // No server prose, key material, JWT or arbitrary error detail is rendered.
      setFailure("The change was refused or could not be recorded. Refresh before retrying; an identity management step-up is required for every write.");
    } finally { setBusy(false); }
  }
  const delegationAllowed = preview && inventory.isSuccess && !inventory.isFetching && !!identity && canPreviewDelegation(identity, delegationPreview);
  useEffect(() => { setDelegationOpen(false); setDelegationResult(null); }, [selectedId, delegationPreview?.viewerId, delegationPreview?.projectId, delegationPreview?.uncappedRootAllowed, delegationPreview?.maxLifetimeSeconds]);
  useEffect(() => { if (!delegationAllowed) { setDelegationOpen(false); setDelegationResult(null); } }, [delegationAllowed]);
  const confirm = (next: Confirmation) => { setFailure(null); setConfirmation(next); };
  return <>
    <PageHeader title="Workload identities" crumbs={["Identity & access"]}
      sub="Manage workload grants and inspect delegated authority."
      info="Register public credentials for callers outside the gateway, manage each workload's own grants, and inspect its delegated authority. With least privilege enabled, empty own grants refuse agent calls. Revocation refuses the next use; an external effect already dispatched cannot be recalled."
      actions={port && <Button disabled={busy || !inventory.data} onClick={() => setForm({ kind: "identity" })}>Add identity</Button>} />
    {preview && <p role="note" className={s.preview}>Mock identity preview — synthetic records and step-up only. This preview does not change deployment permissions.</p>}
    {!port ? <Card><EmptyState title="Workload identity management is not available" body="The deployment has not enabled this administrative surface." /></Card> : <div className={s.stack}>
      {failure && <ErrorState title="Change not recorded" message={failure} onRetry={() => { void qc.invalidateQueries({ queryKey: queryRoot }); setFailure(null); }} />}
      <Card title="Identities" actions={<Button disabled={busy} onClick={() => void inventory.refetch()}>Refresh identities</Button>}>
        <Table rows={inventory.data?.identities} loading={inventory.isPending} error={inventory.error ? new Error("Workload identities could not be read. No empty or active state is inferred.") : undefined}
          onRetry={() => void inventory.refetch()} rowKey={row => row.id}
          empty={<EmptyState title="No workload identities" body="No own permissions are granted to an existing agent by default." />}
          columns={[
            { key: "identifier", header: "Identifier", render: i => <span className={s.identifier}>{i.identifier}</span> },
            { key: "kind", header: "Kind", render: i => workloadKindLabels[i.kind] },
            { key: "stewards", header: "Stewards", render: i => i.stewards.map(p => p.name).join(", ") || "No steward recorded" },
            { key: "environments", header: "Environments", render: i => i.environments.join(", ") || "None allowed" },
            { key: "status", header: "Status", render: i => <Badge tone={i.status === "active" ? "ok" : i.status === "revoked" ? "danger" : "warn"}>{i.status}</Badge> },
            { key: "manage", header: "Manage", render: i => <Button size="sm" aria-label={`Manage ${i.identifier}`} disabled={busy} onClick={() => setSelectedId(i.id)}>Manage</Button> },
          ]} />
      </Card>
      {identity && <Card title="Selected identity">
        <h2 className={s.identifier}>{identity.identifier}</h2>
        <div className={s.actions}>
          {delegationAllowed && <Button disabled={busy} onClick={() => { setDelegationResult(null); setDelegationOpen(true); }}>Preview root delegation</Button>}
          <Button disabled={busy || identity.status === "revoked"} onClick={() => setForm({ kind: "identity", identity })}>Edit stewards and environments</Button>
          <Button disabled={busy || identity.status === "revoked"} onClick={() => confirm({
            title: identity.status === "active" ? "Suspend identity?" : "Restore identity?", label: identity.status === "active" ? "Suspend identity" : "Restore identity",
            body: identity.status === "active" ? "Every grant naming this identity is refused at its next use. Existing grant rows remain for the audit trail." : "The identity becomes active again. Revoked credentials or grants stay revoked and must be replaced separately.",
            command: { operation: "identity_status", identityId: identity.id, status: identity.status === "active" ? "suspended" : "active" },
          })}>{identity.status === "active" ? "Suspend identity" : "Restore identity"}</Button>
          <Button variant="danger" disabled={busy || identity.status === "revoked"} onClick={() => confirm({ title: "Revoke identity?", label: "Revoke identity", body: "This permanently refuses every grant naming the identity and its descendants at the next use. An action already dispatched cannot be recalled.", command: { operation: "identity_status", identityId: identity.id, status: "revoked" } })}>Revoke identity</Button>
        </div>
        {detail.isPending ? <SkeletonBlock lines={3} /> : detail.isError ? <ErrorState message="Credentials and own grants could not be read. No empty or active state is inferred." onRetry={() => void detail.refetch()} /> : detail.data && <>
          <div className={s.heading}><h2>Public credentials</h2><Button disabled={busy || identity.status !== "active"} onClick={() => setForm({ kind: "credential", identity })}>Add public credential</Button></div>
          <p>Private keys stay with the workload. Rotation adds a new public credential; revocation refuses what a credential authenticated.</p>
          <Table rows={detail.data.credentials} rowKey={c => c.id} empty={<EmptyState title="No public credentials" body="An in-process identity uses its grant directly and needs no key. An external caller must register a public credential." />}
            columns={[
              { key: "kind", header: "Kind", render: c => c.kind },
              { key: "fingerprint", header: "Public fingerprint", render: c => <span className={s.identifier}>{c.fingerprint}</span> },
              { key: "validity", header: "Recorded validity", render: c => <>{dateLabel(c.notBefore)} — {dateLabel(c.notAfter)}</> },
              { key: "status", header: "Status", render: c => <Badge tone={credentialStatus(c, at) === "Active" ? "ok" : "neutral"}>{credentialStatus(c, at)}</Badge> },
              { key: "actions", header: "Manage", render: c => <div className={s.actions}>
                <Button size="sm" disabled={busy || identity.status !== "active" || c.revokedAt !== null || c.kind !== "public_key"} onClick={() => setForm({ kind: "credential", identity, previous: c })}>Rotate public key</Button>
                <Button size="sm" variant="danger" disabled={busy || c.revokedAt !== null} aria-label={`Revoke credential ${c.fingerprint}`} onClick={() => confirm({ title: "Revoke credential?", label: "Revoke credential", body: "Every token and grant this credential authenticated, and every descendant grant, is refused at its next use. If it was used only as a token binding, those bound tokens are refused. A revoked credential never becomes live again.", command: { operation: "revoke_credential", identityId: identity.id, credentialId: c.id } })}>Revoke</Button>
              </div> },
            ]} />
          <div className={s.heading}><h2>Own grants</h2><Button disabled={busy || identity.status !== "active"} onClick={() => setForm({ kind: "grant", identity })}>Add own grant</Button></div>
          <p>With least privilege enabled, effective authority is the intersection of the sponsor, every actor, delegation scope and lead ceiling. A role or grant here never widens the sponsor's rights.</p>
          <Table rows={detail.data.grants} rowKey={g => g.id} empty={<EmptyState title="No own grants" body="With own-grants mode enabled, this identity cannot invoke agents, tools or connectors. Its stewards' permissions are not copied to it." />}
            columns={[
              { key: "kind", header: "Kind", render: g => g.kind },
              { key: "target", header: "Target", render: g => g.targetName },
              { key: "tool", header: "Tool", render: g => g.toolName ?? "Not applicable" },
              { key: "access", header: "Access", render: g => ownGrantSummary(g) },
              { key: "remove", header: "Remove", render: g => <Button size="sm" variant="danger" disabled={busy} aria-label={`Remove grant for ${g.targetName}`} onClick={() => confirm({ title: "Remove own grant?", label: "Remove grant", body: "The next use is checked against the identity's remaining grants. Delegated tokens do not preserve a permission removed here. This change replaces all direct grants and roles at the loaded revision; a stale revision is refused. Refresh before editing.", command: { operation: "remove_grant", identityId: identity.id, grantId: g.id } })}>Remove</Button> },
            ]} />
        </>}
      </Card>}
      {preview && <Card title="Delegation safeguards">
        <p>Only an agent's stewards with access to the selected project may delegate it. Unknown access hides the action. Admin status alone does not replace stewardship.</p>
        <p>A root-grant cap is required unless an admin has enabled an audited relaxation. The strict default lifetime and maximum are 15 minutes. Limits are checked again at exchange, even if settings changed after proof creation.</p>
        <p><code>delegation_depth_unenforced</code>: {delegationRefusalMessages.delegation_depth_unenforced}</p>
        <p><code>invalid_target</code>: {delegationRefusalMessages.invalid_target}</p>
        <p>Identity creation, edits, suspension and revocation require <code>identity_manage</code> step-up verification. The real identity-management backend and delegation proof flow remain unavailable in this mock preview.</p>
      </Card>}
      {preview && delegationResult && <p role="status">{delegationResult}</p>}
      <Card title="Run delegation tree">
        <form className={s.actions} onSubmit={event => { event.preventDefault(); setRunId(runInput.trim() || null); }}>
          <Field label="Run ID"><Input value={runInput} onChange={event => setRunInput(event.target.value)} /></Field>
          <Button type="submit" disabled={!runInput.trim() || busy}>Load delegation tree</Button>
          {runId && <Button disabled={busy} onClick={() => void tree.refetch()}>Refresh tree</Button>}
        </form>
        <p>An allocation is held on one parent→child edge. Closing a child returns its unspent capacity to its parent; it reaches the root only as those parents close. One measured call may cross a cap; the next use is refused.</p>
        {!runId ? <EmptyState title="Choose a run" body="The tree shows the human sponsor, every actor and each allocation's measured draw and release." /> : tree.isPending ? <SkeletonBlock lines={3} /> : tree.isError ? <ErrorState message="The delegation tree could not be read. No actor or budget state is inferred." onRetry={() => void tree.refetch()} /> : ordered?.problem ? <ErrorState message={ordered.problem} onRetry={() => void tree.refetch()} /> : <Table rows={ordered?.nodes} rowKey={node => node.id}
          empty={<EmptyState title="No delegation grants recorded" body="This run has no recorded delegation chain." />} columns={[
            { key: "actor", header: "Actor and parent", render: node => <><span className={s.identifier}>{node.identifier}</span><div>{node.parentId ? `Child of ${node.parentId}` : "Root grant"}</div></> },
            { key: "sponsor", header: "Human sponsor / actor chain", render: node => <>{node.sponsor.name}<div>{node.actorChain.join(" → ") || "Unmeasured"}</div></> },
            { key: "budget", header: "Grant budget", render: node => <>Cap {formatMicros(node.capMicros)}<div>Spent {formatMicros(node.settledMicros)}; reserved {formatMicros(node.reservedMicros)}</div><div>Remaining {formatMicros(remainingMicros(node))}</div></> },
            { key: "edge", header: "Incoming edge", render: node => node.allocation ? <>Allocated {formatMicros(node.allocation.amountMicros)}<div>Drawn {formatMicros(node.allocation.drawnMicros)}; released {formatMicros(node.allocation.releasedMicros)}</div><div>{node.allocation.status}</div></> : "Root (no incoming edge)" },
            { key: "status", header: "Status / expiry", render: node => <><Badge tone={node.status === "active" && Date.parse(node.expiresAt) > at ? "ok" : "neutral"}>{node.status === "active" ? (!Number.isFinite(Date.parse(node.expiresAt)) ? "Validity unmeasured" : Date.parse(node.expiresAt) <= at ? "expired" : "active") : node.status}</Badge><div>{dateLabel(node.expiresAt)}</div></> },
            { key: "revoke", header: "Cascade", render: node => <Button size="sm" variant="danger" disabled={busy || node.status !== "active" || !Number.isFinite(Date.parse(node.expiresAt)) || Date.parse(node.expiresAt) <= at} aria-label={`Revoke grant ${node.id} and descendants`} onClick={() => confirm({ title: "Revoke grant and descendants?", label: "Revoke grant and descendants", body: "This grant and every descendant are refused at the next use. Unspent allocations return to the immediate parent, once only. An external effect already dispatched cannot be recalled.", command: { operation: "revoke_delegation", grantId: node.id } })}>Revoke cascade</Button> },
          ]} />}
      </Card>
    </div>}
    {delegationOpen && delegationAllowed && delegationPreview && <RootDelegationPreview context={delegationPreview} onClose={() => setDelegationOpen(false)} onReview={(cap, seconds) => {
      setDelegationOpen(false); setDelegationResult(`Mock root delegation reviewed: ${cap.trim() ? `cap ${formatMicros(cap.trim())}` : "uncapped under an audited admin relaxation"}; lifetime ${seconds / 60} minutes. No proof, grant or token was created.`);
    }} />}
    {form && inventory.data && <IdentityForm form={form} inventory={inventory.data} onClose={() => setForm(null)} onSave={command => { setForm(null); void write(command); }} />}
    <ConfirmModal open={!!confirmation} title={confirmation?.title ?? "Confirm identity change"} body={confirmation?.body} danger confirmLabel={confirmation?.label}
      onCancel={() => setConfirmation(null)} onConfirm={() => { const command = confirmation?.command; setConfirmation(null); if (command) void write(command); }} />
    {busy && <p role="status">Waiting for identity management verification and the recorded change…</p>}
  </>;
}

function Choices({ label, options, selected, onChange }: { label: string; options: Array<{ id: string; name: string }>; selected: string[]; onChange: (next: string[]) => void }) {
  return <fieldset className={s.choices}><legend>{label}</legend>{options.map(option => <label key={option.id}><input type="checkbox" checked={selected.includes(option.id)}
    onChange={event => onChange(event.target.checked ? [...selected, option.id] : selected.filter(id => id !== option.id))} /> {option.name}</label>)}</fieldset>;
}
function IdentityForm({ form, inventory, onClose, onSave }: { form: Form; inventory: IdentityInventory; onClose: () => void; onSave: (command: IdentityWrite) => void }) {
  const initial = form.kind === "identity" ? form.identity : undefined;
  const [kind, setKind] = useState<WorkloadKind>(initial?.kind ?? "agent");
  const [subjectId, setSubjectId] = useState(initial?.subjectId ?? "");
  const [stewards, setStewards] = useState(initial?.stewards.map(p => p.id) ?? []);
  const [environments, setEnvironments] = useState(initial?.environments ?? []);
  const [key, setKey] = useState<PublicKey | null>(null), [fingerprint, setFingerprint] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState(new Date(Date.now() + IDENTITY_STRICT_DEFAULTS.workloadKeyMaxAgeDays * 86400000).toISOString().slice(0, 10));
  const [grantKind, setGrantKind] = useState<OwnGrant["kind"]>("tool"), [targetId, setTargetId] = useState(""), [toolName, setToolName] = useState("");
  const [readOnlyAll, setReadOnlyAll] = useState(true);
  const [connectorMode, setConnectorMode] = useState<"read" | "readwrite">("read");
  const [allowedModes, setAllowedModes] = useState(""), [allowedObjects, setAllowedObjects] = useState("");
  const reads = useRef(0);
  const internal = ["agent", "builder_agent", "engine_runner"].includes(kind);
  const targets = inventory.grantTargets.filter(t => t.kind === grantKind);
  const target = targets.find(t => t.id === targetId);
  const title = form.kind === "identity" ? initial ? "Edit identity" : "Add identity" : form.kind === "grant" ? "Add own grant" : form.previous ? "Rotate public key" : "Add public credential";
  async function chooseFile(file?: File) {
    const read = ++reads.current;
    setKey(null); setFingerprint(null); setError(null); setKeyBusy(false);
    if (!file) return;
    if (file.size > 16384) { setError("Choose a public JWK file under 16 KiB."); return; }
    setKeyBusy(true);
    try {
      const next = readPublicKey(await file.text()), fp = await publicKeyFingerprint(next);
      if (reads.current === read) { setKey(next); setFingerprint(fp); }
    } catch (problem) { if (reads.current === read) setError(problem instanceof Error ? problem.message : "The public key file could not be read."); }
    finally { if (reads.current === read) setKeyBusy(false); }
  }
  function submit() {
    setError(null);
    if (form.kind === "identity") {
      const problem = validateIdentity(kind, internal ? subjectId || null : null, stewards, environments);
      if (problem) { setError(problem); return; }
      onSave(initial ? { operation: "edit_identity", identityId: initial.id, stewardIds: stewards, environments } : { operation: "create_identity", kind, subjectId: internal ? subjectId : null, stewardIds: stewards, environments });
    } else if (form.kind === "credential") {
      const until = Date.parse(`${expiry}T00:00:00.000Z`), duration = until - Date.now();
      if (!key || keyBusy) { setError("Choose and validate a public JWK first."); return; }
      if (!Number.isFinite(until) || duration <= 0 || duration > IDENTITY_SETTING_LIMITS.workloadKeyMaxAgeDays.max * 86400000) { setError("Choose a future expiry no more than 90 days away."); return; }
      onSave({ operation: form.previous ? "rotate_credential" : "add_credential", identityId: form.identity.id,
        ...(form.previous ? { previousCredentialId: form.previous.id } : {}), publicKey: key, notAfter: new Date(until).toISOString() });
    } else {
      if (!target || (grantKind === "tool" && !target.tools?.includes(toolName))) { setError("Choose a permitted target and, for a tool grant, a specific tool."); return; }
      const names = (value: string) => value.split(",").map(name => name.trim()).filter(Boolean);
      const modes = names(allowedModes), objects = names(allowedObjects);
      if (modes.length > 20 || modes.some(mode => mode.length > 64) || new Set(modes).size !== modes.length || objects.length > 500 || objects.some(object => object.length > 200) || new Set(objects).size !== objects.length) {
        setError("Use distinct mode names up to 64 characters and object names up to 200 characters. Choose at most 20 modes or 500 objects."); return;
      }
      onSave({ operation: "add_grant", identityId: form.identity.id, kind: grantKind, targetId, toolName: grantKind === "tool" ? toolName : null, access: null,
        ...(grantKind === "server" ? { readOnlyAll } : {}), ...(grantKind === "agent_invoke" ? { allowedModes: modes } : {}),
        ...(grantKind === "connector" ? { mode: connectorMode, allowedObjects: objects } : {}) });
    }
  }
  return <Modal open title={title} onClose={onClose} actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={keyBusy} onClick={submit}>{title}</Button></>}>
    <div className={s.stack}>
      {error && <p role="alert">{error}</p>}
      {form.kind === "identity" ? <>
        {!initial && <><Field label="Workload kind"><Select value={kind} onChange={event => { setKind(event.target.value as WorkloadKind); setSubjectId(""); }}>{Object.entries(workloadKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
          {internal && <Field label="Subject"><Select value={subjectId} onChange={event => setSubjectId(event.target.value)}><option value="">Choose a subject</option>{inventory.subjects.filter(subject => subject.kind === kind && !inventory.identities.some(identity => identity.subjectId === subject.id)).map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</Select></Field>}</>}
        <Choices label="Stewards" options={inventory.people} selected={stewards} onChange={setStewards} />
        <Choices label="Allowed environments" options={inventory.environments.map(id => ({ id, name: id }))} selected={environments} onChange={setEnvironments} />
        <p>At least one steward is required. Empty environments allow no environment. Own grants start empty; stewards' permissions are never copied onto the identity.</p>
      </> : form.kind === "credential" ? <>
        {form.previous && <p>Rotation adds a new public credential. The previous credential remains valid until its recorded expiry. Revoke it separately to refuse its tokens and grants.</p>}
        <Field label="Public JWK file" help="Choose only the public part of an ES256 or Ed25519 key. File contents are not displayed."><Input type="file" accept="application/json,.json" onChange={event => void chooseFile(event.target.files?.[0])} /></Field>
        {keyBusy && <p role="status">Checking public key…</p>}
        {fingerprint && <p>Public thumbprint: <span className={s.identifier}>{fingerprint}</span></p>}
        <Field label="Credential expiry (UTC)" help="No more than 90 days from now."><Input type="date" value={expiry} onChange={event => setExpiry(event.target.value)} /></Field>
        <p>No private key, shared secret or access token is accepted here. The server validates the public key and records this change after step-up.</p>
      </> : <>
        <Field label="Grant kind"><Select value={grantKind} onChange={event => { setGrantKind(event.target.value as OwnGrant["kind"]); setTargetId(""); setToolName(""); }}>{["tool", "server", "connector", "agent_invoke", "role"].map(value => <option key={value} value={value}>{value}</option>)}</Select></Field>
        <Field label="Grant target"><Select value={targetId} onChange={event => { setTargetId(event.target.value); setToolName(""); }}><option value="">Choose a target</option>{targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        {grantKind === "tool" && <Field label="Tool"><Select value={toolName} onChange={event => setToolName(event.target.value)}><option value="">Choose a tool</option>{target?.tools?.map(tool => <option key={tool} value={tool}>{tool}</option>)}</Select></Field>}
        {grantKind === "server" && <label><input type="checkbox" checked={readOnlyAll} onChange={event => setReadOnlyAll(event.target.checked)} /> Only read-only tools</label>}
        {grantKind === "agent_invoke" && <Field label="Allowed modes" help="Exact mode names, separated by commas. Empty allows no mode; one mode never implies another."><Input value={allowedModes} onChange={event => setAllowedModes(event.target.value)} /></Field>}
        {grantKind === "connector" && <>
          <Field label="Connector access"><Select value={connectorMode} onChange={event => setConnectorMode(event.target.value as "read" | "readwrite")}><option value="read">Read</option><option value="readwrite">Read and write</option></Select></Field>
          <Field label="Allowed objects" help="Exact object names, separated by commas. Empty allows no object; no wildcard is inferred."><Input value={allowedObjects} onChange={event => setAllowedObjects(event.target.value)} /></Field>
        </>}
        <p>This grant narrows delegated authority and cannot exceed the sponsor's rights. Every change replaces all direct grants and roles at the loaded revision. A stale revision is refused; refresh before editing.</p>
      </>}
    </div>
  </Modal>;
}

/** Mock review only: deliberately bypasses neither identity writes nor step-up. */
function RootDelegationPreview({ context, onClose, onReview }: { context: DelegationPreviewContext; onClose: () => void; onReview: (cap: string, seconds: number) => void }) {
  const [cap, setCap] = useState("");
  const [minutes, setMinutes] = useState("15");
  const [error, setError] = useState<string | null>(null);
  function review() {
    const seconds = Number(minutes) * 60;
    const problem = validateRootDelegationPreview(cap, seconds, context);
    setError(problem);
    if (!problem) onReview(cap, seconds);
  }
  return <Modal open title="Preview root delegation" onClose={onClose} actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={review}>Review mock delegation</Button></>}>
    <div className={s.stack}>
      {error && <p role="alert">{error}</p>}
      <Field label="Root cap (micro-dollars)" help={context.uncappedRootAllowed === true ? "An admin has relaxed the cap requirement; leaving this empty previews an uncapped root." : "Required. No cap is supplied by default."}><Input inputMode="numeric" value={cap} onChange={event => setCap(event.target.value)} /></Field>
      <Field label="Lifetime (minutes)" help={`Default 15 minutes; current maximum ${context.maxLifetimeSeconds / 60} minutes.`}><Input type="number" min="1" value={minutes} onChange={event => setMinutes(event.target.value)} /></Field>
      <p>Mock review only. Delegating a sensitive write also requires step-up. No delegation proof, private key, access token or live grant is created here.</p>
    </div>
  </Modal>;
}
