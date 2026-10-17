/**
 * ADR-0188 S6 — workload identities: an agent principal's identity, its
 * stewards and environments, its OWN grants, and a run's delegation tree.
 *
 * In the Identity & Access navigation group (ADR-0177 §3: no new group), beside
 * the credential inventory, now that every identity route is live. Every control is wired
 * to a live route: the S4 list/detail/PATCH/grants routes, the S5
 * delegation-grant list and cascade revoke, and (S6) creating and revoking an
 * identity, its public credentials, the grant proposals from observed use and
 * the picker sources. `IDENTITY_ROUTES_NOT_BUILT` (pinned against the gateway
 * by the model test) is empty; a stub that reappears must be listed there and
 * its control disabled, never left to report a success.
 *
 * Every write is an `identity_manage` step-up (the shell's "Confirm it's you"
 * dialog) behind a confirmation that states the consequence.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, ErrorState, Field, InfoButton, Input, Modal, Select, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { useAgents, useConnectors, useRoles, useServers, useServerTools, useUserPicker } from "../adminKit";
import {
  addIdentityCredential,
  createWorkloadIdentity,
  getGrantProposals,
  getIdentityGrants,
  getIdentityPickerSources,
  getWorkloadIdentity,
  listIdentityCredentials,
  listRunDelegationTree,
  listWorkloadIdentities,
  replaceIdentityGrants,
  revokeDelegationGrant,
  revokeIdentityCredential,
  revokeWorkloadIdentity,
  updateWorkloadIdentity,
  workloadIdentityKeys,
} from "./workloadIdentityApi";
import {
  EXTERNAL_IDENTITY_KINDS,
  GRANTS_REVISION_CONFLICT,
  SUBJECT_COLUMN,
  UUID_PATTERN,
  WORKLOAD_CREDENTIAL_KINDS,
  WORKLOAD_CREDENTIAL_MAX_DAYS,
  WORKLOAD_IDENTITY_KINDS,
  WORKLOAD_IDENTITY_MAX_STEWARDS,
  createIdentityBody,
  credentialBody,
  credentialFact,
  credentialKindLabels,
  credentialState,
  delegationRefusalMessages,
  delegationState,
  environmentNameProblem,
  formatMicros,
  grantKindLabels,
  grantRows,
  grantSetWith,
  grantSetWithout,
  identityRefusalSentence,
  nameList,
  orderedDelegationTree,
  defaultProposalSelection,
  proposalKey,
  proposalLabel,
  setWithProposals,
  proposalTargetId,
  remainingMicros,
  stewardsAndEnvironmentsChange,
  validateStewardsAndEnvironments,
  workloadKindLabels,
  type AgentGrantsView,
  type ConnectorGrantMode,
  type CreateWorkloadIdentityBody,
  type CredentialDraft,
  type IdentityGrantProposal,
  type WorkloadCredentialKind,
  type WorkloadCredentialView,
  type WorkloadIdentityKind,
  type GrantAddition,
  type GrantKind,
  type GrantRow,
  type WorkloadIdentityDetailView,
  type WorkloadIdentityView,
  pickerTruncationNotice,
} from "./workloadIdentityModel";
import { DelegationGrantDetail, IssuerSigningKeysCard } from "./IssuerSigningKeys";
import { SpiffeTrustBundlesCard } from "./SpiffeTrustBundles";
import s from "./workloadIdentities.module.css";
import { OrgSettingsCard } from "../settings/OrgSettingsCard";

const dateLabel = (value: string | null) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Unmeasured");

/**
 * A control that exists but cannot act here, with the reason one focusable
 * click away. `aria-disabled` rather than `disabled`, so keyboard and screen
 * reader users reach it and its reason (the adminKit RemoveButton pattern).
 */
function Unavailable(props: { label: string; reason: ReactNode; size?: "sm" }) {
  return (
    <span className={s.unavailable}>
      <Button
        size={props.size}
        aria-disabled
        style={{ opacity: 0.5, cursor: "not-allowed" }}
        aria-label={`${props.label} — unavailable`}
        onClick={(e) => e.preventDefault()}
      >
        {props.label}
      </Button>
      <InfoButton label={`the reason ${props.label} is unavailable`}>{props.reason}</InfoButton>
    </span>
  );
}

interface Confirmation {
  title: string;
  body: ReactNode;
  label: string;
  danger: boolean;
  okMessage: string;
  run: () => Promise<unknown>;
}

/** one write at a time; a refusal becomes a sentence, never a success */
function useIdentityWrite() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, okMessage: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setFailure(null);
    try {
      await fn();
      toast(okMessage, "success");
      return true;
    } catch (e) {
      const code = e instanceof ApiError ? e.payload.error : undefined;
      const message = identityRefusalSentence(code) ?? (e instanceof Error ? e.message : "The change could not be recorded.");
      setFailure(message);
      toast(message, "error");
      return false;
    } finally {
      // a refusal can mean the page is stale (a 409 revision conflict above all): reload either way
      await qc.invalidateQueries({ queryKey: workloadIdentityKeys.root });
      setBusy(false);
    }
  };
  return { busy, failure, setFailure, run };
}

export default function WorkloadIdentitiesPage() {
  const write = useIdentityWrite();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [editing, setEditing] = useState<WorkloadIdentityDetailView | null>(null);
  const [addingGrant, setAddingGrant] = useState<{ identity: WorkloadIdentityDetailView; set: AgentGrantsView } | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingCredential, setAddingCredential] = useState<WorkloadIdentityDetailView | null>(null);

  const identities = useInfiniteQuery({
    queryKey: workloadIdentityKeys.list,
    queryFn: ({ pageParam }) => listWorkloadIdentities(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = useMemo(() => identities.data?.pages.flatMap((p) => p.items), [identities.data]);
  const people = useUserPicker();
  const userName = useMemo(
    () => new Map((people.data?.users ?? []).map((u) => [u.id, u.displayName || u.email])),
    [people.data],
  );
  const personLabel = (id: string) => userName.get(id) ?? (people.isPending ? "Loading…" : `Not loaded (${id})`);

  useEffect(() => {
    if (selectedId && rows && !rows.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [rows, selectedId]);

  const ask = (c: Confirmation) => {
    write.setFailure(null);
    setConfirmation(c);
  };

  return (
    <>
      <PageHeader
        title="Workload identities"
        crumbs={["Identity & access"]}
        sub="Each agent's own identity, stewards, environments and grants, and the delegated authority of a run."
        info={
          <>
            An agent principal acts under its own identity. Its stewards are the people answerable for it; its own grants
            start empty and never exceed what its stewards hold. With least privilege enabled, effective authority at each
            call is the intersection of the human sponsor, every actor in the chain, the delegation scope and the lead's
            ceiling. Suspending or revoking refuses the next use; an external effect already dispatched cannot be recalled.
          </>
        }
        actions={
          <Button variant="primary" disabled={write.busy} onClick={() => setCreating(true)}>
            Add identity
          </Button>
        }
      />
      <div className={s.stack}>
        <p role="note" className={s.preview}>
          Every change here is made on the live gateway, asks you to confirm it&apos;s you, and is recorded in the audit log.
          Revoking an identity or a credential cannot be undone.
        </p>
        {write.failure && (
          <ErrorState title="Change not recorded" message={write.failure} onRetry={() => write.setFailure(null)} />
        )}
        <Card
          title="Identities"
          actions={
            <Button disabled={write.busy || identities.isFetching} onClick={() => void identities.refetch()}>
              Refresh identities
            </Button>
          }
        >
          <Table<WorkloadIdentityView>
            rows={rows}
            loading={identities.isPending}
            error={identities.error ? new Error("Workload identities could not be read. No empty or active state is inferred.") : undefined}
            onRetry={() => void identities.refetch()}
            rowKey={(i) => i.id}
            empty={
              <EmptyState
                title="No workload identities"
                body="No agent has an identity of its own yet. Nothing is granted to an agent by default."
              />
            }
            columns={[
              { key: "identifier", header: "Identifier", render: (i) => <span className={s.identifier}>{i.identifier}</span> },
              { key: "kind", header: "Kind", render: (i) => workloadKindLabels[i.kind] ?? i.kind },
              { key: "stewards", header: "Stewards", render: (i) => i.sponsorUserIds.map(personLabel).join(", ") || "No steward recorded" },
              { key: "environments", header: "Environments", render: (i) => i.environments.join(", ") || "None allowed" },
              { key: "status", header: "Status", render: (i) => <StatusBadge status={i.status} /> },
              {
                key: "manage",
                header: "Manage",
                render: (i) => (
                  <Button size="sm" aria-label={`Manage ${i.identifier}`} aria-pressed={selectedId === i.id} onClick={() => setSelectedId(i.id)}>
                    Manage
                  </Button>
                ),
              },
            ]}
          />
          {identities.hasNextPage && (
            <Button disabled={identities.isFetchingNextPage} onClick={() => void identities.fetchNextPage()}>
              {identities.isFetchingNextPage ? "Loading more…" : "Load more identities"}
            </Button>
          )}
          {people.data && !people.data.complete && (
            <p>Only the first page of people was loaded, so some stewards show as “Not loaded”. That is not a statement that they are inactive.</p>
          )}
        </Card>

        {selectedId && (
          <SelectedIdentity
            identityId={selectedId}
            busy={write.busy}
            personLabel={personLabel}
            onEdit={setEditing}
            onAddGrant={(identity, set) => setAddingGrant({ identity, set })}
            onAddCredential={setAddingCredential}
            ask={ask}
          />
        )}

        <Card title="Delegation safeguards">
          <p>
            Only an agent&apos;s stewards who can access the project may delegate it; admin status alone does not replace
            stewardship. A root grant needs a cap unless an admin has turned on an audited relaxation, and lives 15 minutes by
            default. Limits are checked again at exchange, even if settings changed after the proof was created.
          </p>
          <p>
            <code>delegation_depth_unenforced</code>: {delegationRefusalMessages.delegation_depth_unenforced}
          </p>
          <p>
            <code>invalid_target</code>: {delegationRefusalMessages.invalid_target}
          </p>
        </Card>

        {/* ADR-0188 decision 10: least privilege, token lifetime, chain depth, workload sign-in and the root-grant limits */}
        <OrgSettingsCard
          title="Agent identity and delegation settings"
          keys={[
            "agentEntitlementMode",
            "delegatedTokenTtlSeconds",
            "delegationMaxDepth",
            "workloadClientAuthMethods",
            "dpopNonceRequired",
            "workloadKeyMaxAgeDays",
            "delegationUncappedRootAllowed",
            "delegationRootDefaultCapMicros",
            "delegationRootMaxLifetimeSeconds",
          ]}
          testId="identity-delegation-settings"
        />

        <IssuerSigningKeysCard busy={write.busy} ask={ask} />

        {/* ADR-0188 S9: the SPIFFE trust bundles, in audited storage */}
        <SpiffeTrustBundlesCard busy={write.busy} ask={ask} />

        <RunDelegationTree busy={write.busy} personLabel={personLabel} identities={rows} ask={ask} />
      </div>

      {editing && (
        <StewardsEditor
          identity={editing}
          people={people.data?.users ?? []}
          personLabel={personLabel}
          onClose={() => setEditing(null)}
          onSave={(change) => {
            const identity = editing;
            setEditing(null);
            ask({
              title: "Change stewards and environments?",
              label: "Save changes",
              danger: false,
              okMessage: "Stewards and environments updated.",
              body: (
                <>
                  The identity&apos;s current own grants must still be held by its new stewards, or the change is refused.
                  An environment removed here is refused at the identity&apos;s next use there.
                </>
              ),
              run: () => updateWorkloadIdentity(identity.id, change),
            });
          }}
        />
      )}
      {addingGrant && (
        <GrantEditor
          set={addingGrant.set}
          onClose={() => setAddingGrant(null)}
          onSave={(next, what) => {
            const identity = addingGrant.identity;
            setAddingGrant(null);
            ask({
              title: "Add own grant?",
              label: "Add grant",
              danger: false,
              okMessage: "Own grant added.",
              body: (
                <>
                  Adds {what}. This replaces all of the identity&apos;s direct grants and roles at the revision loaded
                  ({next.revision}); if another change landed first, nothing is replaced. A grant never exceeds what the
                  identity&apos;s stewards hold.
                </>
              ),
              run: () => replaceIdentityGrants(identity.id, next),
            });
          }}
        />
      )}
      {creating && (
        <CreateIdentityDialog
          onClose={() => setCreating(false)}
          onSave={(body, what) => {
            setCreating(false);
            ask({
              title: "Create workload identity?",
              label: "Create identity",
              danger: false,
              okMessage: "Workload identity created.",
              body: (
                <>
                  Creates {what}. It starts active with no grants of its own; grant it only what its stewards hold.
                </>
              ),
              run: () => createWorkloadIdentity(body),
            });
          }}
        />
      )}
      {addingCredential && (
        <CredentialDialog
          onClose={() => setAddingCredential(null)}
          onSave={(body, what) => {
            const identity = addingCredential;
            setAddingCredential(null);
            ask({
              title: "Add public credential?",
              label: "Add credential",
              danger: false,
              okMessage: "Public credential added.",
              body: (
                <>
                  Binds {what} to {identity.identifier}. Whoever holds the matching private key can then sign in as this
                  identity until the credential ends or is revoked.
                </>
              ),
              run: () => addIdentityCredential(identity.id, body),
            });
          }}
        />
      )}
      <ConfirmModal
        open={!!confirmation}
        title={confirmation?.title ?? "Confirm identity change"}
        body={
          <>
            <p>{confirmation?.body}</p>
            <p>You will be asked to confirm it&apos;s you; the change is recorded in the audit log.</p>
          </>
        }
        danger={confirmation?.danger ?? true}
        confirmLabel={confirmation?.label}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          const c = confirmation;
          setConfirmation(null);
          if (c) void write.run(c.run, c.okMessage);
        }}
      />
      {write.busy && <p role="status">Waiting for identity verification and the recorded change…</p>}
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={status === "active" ? "ok" : status === "revoked" ? "danger" : "warn"}>{status}</Badge>;
}

function SelectedIdentity(props: {
  identityId: string;
  busy: boolean;
  personLabel: (id: string) => string;
  onEdit: (identity: WorkloadIdentityDetailView) => void;
  onAddGrant: (identity: WorkloadIdentityDetailView, set: AgentGrantsView) => void;
  onAddCredential: (identity: WorkloadIdentityDetailView) => void;
  ask: (c: Confirmation) => void;
}) {
  const detail = useQuery({ queryKey: workloadIdentityKeys.detail(props.identityId), queryFn: () => getWorkloadIdentity(props.identityId) });
  const grants = useQuery({ queryKey: workloadIdentityKeys.grants(props.identityId), queryFn: () => getIdentityGrants(props.identityId) });
  const servers = useServers();
  const agents = useAgents();
  const connectors = useConnectors();
  const roles = useRoles();
  const targetName = (row: GrantRow): string => {
    const lists: Record<GrantKind, Array<{ id: string; name: string }> | undefined> = {
      tool: servers.data?.servers,
      server: servers.data?.servers,
      agent: agents.data?.agents,
      connector: connectors.data?.connectors,
      role: roles.data?.roles,
    };
    return lists[row.kind]?.find((t) => t.id === row.targetId)?.name ?? `Not loaded (${row.targetId})`;
  };

  if (detail.isPending) return <Card title="Selected identity"><SkeletonBlock lines={4} /></Card>;
  if (detail.isError) {
    return (
      <Card title="Selected identity">
        <ErrorState message="This identity could not be read. No status or grant is inferred." onRetry={() => void detail.refetch()} />
      </Card>
    );
  }
  const identity = detail.data;
  const revoked = identity.status === "revoked";
  const active = identity.status === "active";
  const inactiveReason = revoked
    ? "A revoked identity is terminal; it cannot be changed."
    : "Only an active identity's grants can be changed. Restore it first.";
  return (
    <Card title="Selected identity">
      <h2 className={s.identifier}>{identity.identifier}</h2>
      <dl className={s.facts}>
        <dt>Kind</dt>
        <dd>{workloadKindLabels[identity.kind] ?? identity.kind}</dd>
        <dt>Status</dt>
        <dd><StatusBadge status={identity.status} /></dd>
        <dt>Stewards</dt>
        <dd>{identity.sponsorUserIds.map(props.personLabel).join(", ") || "No steward recorded"}</dd>
        <dt>Environments</dt>
        <dd>{identity.environments.join(", ") || "None allowed"}</dd>
        <dt>Live delegation grants</dt>
        <dd>{identity.liveDelegationGrantCount}</dd>
        <dt>Created</dt>
        <dd>{dateLabel(identity.createdAt)}</dd>
      </dl>
      <div className={s.actions}>
        {revoked ? (
          <Unavailable label="Edit stewards and environments" reason={inactiveReason} />
        ) : (
          <Button disabled={props.busy} onClick={() => props.onEdit(identity)}>
            Edit stewards and environments
          </Button>
        )}
        {revoked ? (
          <Unavailable label="Suspend identity" reason={inactiveReason} />
        ) : (
          <Button
            disabled={props.busy}
            onClick={() =>
              props.ask(
                active
                  ? {
                      title: "Suspend identity?",
                      label: "Suspend identity",
                      danger: true,
                      okMessage: "Identity suspended.",
                      body: "Every grant naming this identity is refused at its next use. Its grants and credentials stay recorded, and it can be restored.",
                      run: () => updateWorkloadIdentity(identity.id, { status: "suspended" }),
                    }
                  : {
                      title: "Restore identity?",
                      label: "Restore identity",
                      danger: false,
                      okMessage: "Identity restored.",
                      body: "The identity becomes active again with the grants it had. Anything revoked meanwhile stays revoked.",
                      run: () => updateWorkloadIdentity(identity.id, { status: "active" }),
                    },
              )
            }
          >
            {active ? "Suspend identity" : "Restore identity"}
          </Button>
        )}
        {revoked ? (
          <Unavailable label="Revoke identity" reason="This identity is already revoked. Revocation is terminal." />
        ) : (
          <Button
            variant="danger"
            disabled={props.busy}
            onClick={() =>
              props.ask({
                title: "Revoke identity permanently?",
                label: "Revoke identity",
                danger: true,
                okMessage: "Identity revoked.",
                body: `${identity.identifier} is revoked for good, with its public credentials, its tokens and every delegation grant naming it. It can never be restored, and its subject never gets another identity; suspend it instead if you may need it again. An external effect already dispatched cannot be recalled.`,
                run: () => revokeWorkloadIdentity(identity.id),
              })
            }
          >
            Revoke identity
          </Button>
        )}
      </div>

      <IdentityCredentials identity={identity} busy={props.busy} active={active} inactiveReason={inactiveReason} onAdd={() => props.onAddCredential(identity)} ask={props.ask} />

      <div className={s.heading}>
        <h2>Own grants</h2>
        {!active ? (
          <Unavailable label="Add own grant" reason={inactiveReason} />
        ) : (
          <Button disabled={props.busy || !grants.data} onClick={() => grants.data && props.onAddGrant(identity, grants.data)}>
            Add own grant
          </Button>
        )}
      </div>
      <p>
        A grant here narrows what the agent may do on a person&apos;s behalf; it never widens the sponsor&apos;s rights. Every
        change replaces the whole set at the revision loaded{grants.data ? ` (revision ${grants.data.revision})` : ""}.
      </p>
      {grants.isError ? (
        <ErrorState message="Own grants could not be read. No empty set is inferred." onRetry={() => void grants.refetch()} />
      ) : (
        <Table<GrantRow>
          rows={grants.data ? grantRows(grants.data) : undefined}
          loading={grants.isPending}
          rowKey={(r) => r.key}
          empty={
            <EmptyState
              title="No own grants"
              body="With own-grants mode enabled, this identity cannot invoke agents, tools or connectors. Its stewards' permissions are not copied to it."
            />
          }
          columns={[
            { key: "kind", header: "Kind", render: (r) => grantKindLabels[r.kind] },
            { key: "target", header: "Target", render: (r) => targetName(r) },
            { key: "tool", header: "Tool", render: (r) => r.toolName ?? "Not applicable" },
            { key: "access", header: "Access", render: (r) => r.access },
            {
              key: "remove",
              header: "Remove",
              render: (r) =>
                !active ? (
                  <Unavailable size="sm" label={`Remove ${targetName(r)}`} reason={inactiveReason} />
                ) : (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={props.busy}
                    aria-label={`Remove grant on ${targetName(r)}${r.toolName ? ` (${r.toolName})` : ""}`}
                    onClick={() => {
                      const set = grants.data;
                      const next = set ? grantSetWithout(set, r.key) : null;
                      if (!next) return void grants.refetch();
                      props.ask({
                        title: "Remove own grant?",
                        label: "Remove grant",
                        danger: true,
                        okMessage: "Own grant removed.",
                        body: `The identity's next use is checked without this grant; delegated tokens do not keep it. This replaces all direct grants and roles at revision ${next.revision}; if another change landed first, nothing is replaced.`,
                        run: () => replaceIdentityGrants(identity.id, next),
                      });
                    }}
                  >
                    Remove
                  </Button>
                ),
            },
          ]}
        />
      )}
      {active && grants.data && (
        <GrantProposals
          identity={identity}
          busy={props.busy}
          targetName={(id) => {
            const named: Array<{ id: string; name: string }> = [...(servers.data?.servers ?? []), ...(agents.data?.agents ?? []), ...(connectors.data?.connectors ?? [])];
            return named.find((t) => t.id === id)?.name ?? `Not loaded (${id})`;
          }}
          ask={props.ask}
        />
      )}
    </Card>
  );
}

function RunDelegationTree(props: {
  busy: boolean;
  personLabel: (id: string) => string;
  identities: WorkloadIdentityView[] | undefined;
  ask: (c: Confirmation) => void;
}) {
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const tree = useQuery({ queryKey: workloadIdentityKeys.tree(runId ?? ""), queryFn: () => listRunDelegationTree(runId!), enabled: !!runId });
  const ordered = tree.data && !tree.data.truncated ? orderedDelegationTree(tree.data) : null;
  const problem = tree.data?.truncated ? "This run has more delegation grants than can be displayed here." : ordered?.problem ?? null;
  const actorLabel = (id: string) => props.identities?.find((i) => i.id === id)?.identifier ?? id;

  return (
    <Card title="Run delegation tree">
      <form
        className={s.actions}
        onSubmit={(e) => {
          e.preventDefault();
          const value = input.trim();
          if (!UUID_PATTERN.test(value)) return setInputError("Enter a run ID (a UUID, as shown on the run's page).");
          setInputError(null);
          setRunId(value);
        }}
      >
        <Field label="Run ID" error={inputError}>
          <Input value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Button type="submit" disabled={!input.trim()}>
          Load delegation tree
        </Button>
        {runId && (
          <Button disabled={tree.isFetching} onClick={() => void tree.refetch()}>
            Refresh tree
          </Button>
        )}
      </form>
      <p>
        An allocation is held on one parent→child edge. Closing a child returns its unspent capacity to its parent; it reaches
        the root only as those parents close. One measured call may cross a cap; the next use is refused.
      </p>
      {!runId ? (
        <EmptyState title="Choose a run" body="The tree shows the human sponsor, every actor, and each edge's allocation, draw and release." />
      ) : tree.isPending ? (
        <SkeletonBlock lines={3} />
      ) : tree.isError ? (
        <ErrorState message="The delegation tree could not be read. No actor or budget state is inferred." onRetry={() => void tree.refetch()} />
      ) : problem ? (
        <ErrorState message={problem} onRetry={() => void tree.refetch()} />
      ) : (
        <Table
          rows={ordered?.rows}
          rowKey={(r) => r.grant.id}
          empty={<EmptyState title="No delegation grants recorded" body="This run has no recorded delegation chain." />}
          columns={[
            {
              key: "actor",
              header: "Actor",
              render: (r) => (
                <div style={{ paddingInlineStart: `calc(${r.level} * var(--s3))` }}>
                  <span className={s.identifier}>{actorLabel(r.grant.actorIdentityId)}</span>
                  <div>{r.grant.parentGrantId ? `Depth ${r.grant.depth}, delegated from its parent row` : "Root grant"}</div>
                </div>
              ),
            },
            { key: "sponsor", header: "Human sponsor", render: (r) => props.personLabel(r.grant.sponsorUserId) },
            {
              key: "budget",
              header: "Grant budget",
              render: (r) => (
                <>
                  {r.grant.capMicros === null ? "Uncapped" : `Cap ${formatMicros(r.grant.capMicros)}`}
                  <div>
                    Spent {formatMicros(r.grant.settledMicros)}; reserved {formatMicros(r.grant.reservedMicros)}
                  </div>
                  {r.grant.capMicros !== null && <div>Remaining {formatMicros(remainingMicros(r.grant))}</div>}
                </>
              ),
            },
            {
              key: "edge",
              header: "Incoming edge",
              render: (r) =>
                r.allocation ? (
                  <>
                    Allocated {formatMicros(r.allocation.amountMicros)}
                    <div>
                      Drawn {formatMicros(r.allocation.drawnMicros)}; released {formatMicros(r.allocation.releasedMicros)}
                    </div>
                    <div>{r.allocation.status}</div>
                  </>
                ) : r.grant.parentGrantId === null ? (
                  "Root (no incoming edge)"
                ) : (
                  // The list route returns only edges whose BOTH ends are on the
                  // same page, so a child whose parent arrived on another page
                  // has its edge missing here. That is "not loaded", never a root.
                  "Edge not loaded"
                ),
            },
            {
              key: "status",
              header: "Status",
              render: (r) => {
                const state = delegationState(r.grant, now);
                return (
                  <>
                    <Badge tone={state === "live" ? "ok" : state === "revoked" ? "danger" : "neutral"}>{state}</Badge>
                    <div>
                      {state === "revoked" ? `Revoked ${dateLabel(r.grant.revokedAt)}` : `Expires ${dateLabel(r.grant.expiresAt)}`}
                    </div>
                  </>
                );
              },
            },
            {
              key: "detail",
              header: "Detail",
              render: (r) => (
                <Button size="sm" variant="ghost" aria-label={`Details of the grant for ${actorLabel(r.grant.actorIdentityId)}`} onClick={() => setDetailId(r.grant.id)}>
                  Details
                </Button>
              ),
            },
            {
              key: "revoke",
              header: "Cascade",
              render: (r) =>
                r.grant.revokedAt !== null ? (
                  <Unavailable size="sm" label="Revoke cascade" reason="This grant is already revoked, and so is everything below it." />
                ) : (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={props.busy}
                    aria-label={`Revoke grant for ${actorLabel(r.grant.actorIdentityId)} and its descendants`}
                    onClick={() =>
                      props.ask({
                        title: "Revoke grant and descendants?",
                        label: "Revoke grant and descendants",
                        danger: true,
                        okMessage: "Delegation grant revoked with its descendants.",
                        body: "This grant and every descendant are refused at the next use. Unspent allocations return to the immediate parent, once. An external effect already dispatched cannot be recalled.",
                        run: () => revokeDelegationGrant(r.grant.id),
                      })
                    }
                  >
                    Revoke cascade
                  </Button>
                ),
            },
          ]}
        />
      )}
      {runId && tree.data && !problem && <p>Status uses this browser&apos;s clock; the gateway judges expiry on its own clock.</p>}
      {detailId && <DelegationGrantDetail grantId={detailId} actorLabel={actorLabel} personLabel={props.personLabel} onClose={() => setDetailId(null)} />}
    </Card>
  );
}

function StewardsEditor(props: {
  identity: WorkloadIdentityView;
  people: Array<{ id: string; displayName: string; email: string; disabledAt: string | null }>;
  personLabel: (id: string) => string;
  onClose: () => void;
  onSave: (change: { sponsorUserIds?: string[]; environments?: string[] }) => void;
}) {
  const [stewards, setStewards] = useState<string[]>(props.identity.sponsorUserIds);
  const [environments, setEnvironments] = useState<string[]>(props.identity.environments);
  const [stewardChoice, setStewardChoice] = useState("");
  const [envDraft, setEnvDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const candidates = props.people.filter((p) => p.disabledAt === null && !stewards.includes(p.id));

  const save = () => {
    const problem = validateStewardsAndEnvironments(stewards, environments);
    if (problem) return setError(problem);
    const change = stewardsAndEnvironmentsChange(props.identity, stewards, environments);
    if (!change) return setError("Nothing has changed.");
    props.onSave(change);
  };
  const addEnvironment = () => {
    const name = envDraft.trim();
    const problem = environmentNameProblem(name);
    if (problem) return setError(problem);
    if (environments.includes(name)) return setError("That environment is already allowed.");
    setError(null);
    setEnvironments([...environments, name]);
    setEnvDraft("");
  };

  return (
    <Modal
      open
      title="Edit stewards and environments"
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Review change
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        {error && <p role="alert">{error}</p>}
        <fieldset>
          <legend>Stewards</legend>
          <ul className={s.chips} aria-label="Current stewards">
            {stewards.map((id) => (
              <li key={id} className={s.chip}>
                {props.personLabel(id)}
                <Button size="sm" variant="ghost" aria-label={`Remove steward ${props.personLabel(id)}`} onClick={() => setStewards(stewards.filter((x) => x !== id))}>
                  ×
                </Button>
              </li>
            ))}
          </ul>
          <div className={s.actions}>
            <Field label="Add a steward" help={`At least one, at most ${WORKLOAD_IDENTITY_MAX_STEWARDS}. Only enabled people are offered.`}>
              <Select value={stewardChoice} onChange={(e) => setStewardChoice(e.target.value)}>
                <option value="">Choose a person</option>
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName || p.email} · {p.email}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              disabled={!stewardChoice}
              onClick={() => {
                setStewards([...stewards, stewardChoice]);
                setStewardChoice("");
              }}
            >
              Add steward
            </Button>
          </div>
        </fieldset>
        <fieldset>
          <legend>Allowed environments</legend>
          {environments.length === 0 ? (
            <p>None allowed: the identity is refused in every environment.</p>
          ) : (
            <ul className={s.chips} aria-label="Allowed environments">
              {environments.map((env) => (
                <li key={env} className={s.chip}>
                  <code>{env}</code>
                  <Button size="sm" variant="ghost" aria-label={`Remove environment ${env}`} onClick={() => setEnvironments(environments.filter((x) => x !== env))}>
                    ×
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className={s.actions}>
            <Field label="Add an environment" help="An exact name such as dev, staging or byoc. No wildcard is inferred.">
              <Input value={envDraft} onChange={(e) => setEnvDraft(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <Button disabled={!envDraft.trim()} onClick={addEnvironment}>
              Add environment
            </Button>
          </div>
        </fieldset>
        <p>Stewards&apos; own permissions are never copied onto the identity; they bound what it may be granted.</p>
      </div>
    </Modal>
  );
}

function GrantEditor(props: {
  set: AgentGrantsView;
  onClose: () => void;
  onSave: (next: AgentGrantsView, what: string) => void;
}) {
  const servers = useServers();
  const agents = useAgents();
  const connectors = useConnectors();
  const roles = useRoles();
  const [kind, setKind] = useState<GrantKind>("tool");
  const [targetId, setTargetId] = useState("");
  const [toolName, setToolName] = useState("");
  // secure by default: a whole-server grant starts read-only, a connector grant read-only with no object
  const [readOnlyAll, setReadOnlyAll] = useState(true);
  const [connectorMode, setConnectorMode] = useState<ConnectorGrantMode>("read");
  const [modes, setModes] = useState("");
  const [objects, setObjects] = useState("");
  const [error, setError] = useState<string | null>(null);
  const tools = useServerTools(kind === "tool" && targetId ? targetId : null);

  const targets: Array<{ id: string; name: string }> =
    kind === "tool" || kind === "server"
      ? servers.data?.servers ?? []
      : kind === "agent"
        ? agents.data?.agents ?? []
        : kind === "connector"
          ? connectors.data?.connectors ?? []
          : roles.data?.roles ?? [];
  const targetsLoading = kind === "tool" || kind === "server" ? servers.isPending : kind === "agent" ? agents.isPending : kind === "connector" ? connectors.isPending : roles.isPending;
  const targetName = targets.find((t) => t.id === targetId)?.name ?? "the chosen target";

  const save = () => {
    if (!targetId) return setError("Choose a target from the list.");
    let add: GrantAddition;
    let what: string;
    switch (kind) {
      case "tool":
        if (!toolName) return setError("Choose one tool of the server.");
        add = { kind, serverId: targetId, toolName };
        what = `the tool ${toolName} on ${targetName}`;
        break;
      case "server":
        add = { kind, serverId: targetId, readOnlyAll };
        what = `${readOnlyAll ? "every read-only tool" : "every tool, including writes,"} on ${targetName}`;
        break;
      case "agent":
        add = { kind, agentId: targetId, allowedModes: nameList(modes) };
        what = `invoking ${targetName}`;
        break;
      case "connector":
        add = { kind, connectorId: targetId, mode: connectorMode, allowedObjects: nameList(objects) };
        what = `${connectorMode === "read" ? "read" : "read and write"} access to ${targetName}`;
        break;
      case "role":
        add = { kind, roleId: targetId };
        what = `the role ${targetName}`;
        break;
    }
    const next = grantSetWith(props.set, add);
    if (typeof next === "string") return setError(next);
    props.onSave({ ...next, identityId: props.set.identityId }, what);
  };

  return (
    <Modal
      open
      title="Add own grant"
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Review grant
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        {error && <p role="alert">{error}</p>}
        <Field label="Grant kind">
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as GrantKind);
              setTargetId("");
              setToolName("");
              setError(null);
            }}
          >
            {(Object.keys(grantKindLabels) as GrantKind[]).map((k) => (
              <option key={k} value={k}>
                {grantKindLabels[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={kind === "tool" ? "Server" : "Target"}>
          <Select
            value={targetId}
            onChange={(e) => {
              setTargetId(e.target.value);
              setToolName("");
            }}
          >
            <option value="">{targetsLoading ? "Loading…" : "Choose a target"}</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        {kind === "tool" && (
          <Field label="Tool">
            <Select value={toolName} onChange={(e) => setToolName(e.target.value)} disabled={!targetId}>
              <option value="">{targetId && tools.isPending ? "Loading…" : "Choose a tool"}</option>
              {(tools.data?.tools ?? []).map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.kind})
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind === "server" && (
          <label>
            <input type="checkbox" checked={readOnlyAll} onChange={(e) => setReadOnlyAll(e.target.checked)} /> Only its read-only tools
          </label>
        )}
        {kind === "agent" && (
          <Field label="Allowed modes" help="Exact mode names, separated by commas. Empty allows no mode; one mode never implies another.">
            <Input value={modes} onChange={(e) => setModes(e.target.value)} autoComplete="off" />
          </Field>
        )}
        {kind === "connector" && (
          <>
            <Field label="Connector access">
              <Select value={connectorMode} onChange={(e) => setConnectorMode(e.target.value as ConnectorGrantMode)}>
                <option value="read">Read</option>
                <option value="readwrite">Read and write</option>
              </Select>
            </Field>
            <Field label="Allowed objects" help="Exact object names, separated by commas. Empty allows no object; no wildcard is inferred.">
              <Input value={objects} onChange={(e) => setObjects(e.target.value)} autoComplete="off" />
            </Field>
          </>
        )}
        <p>A grant never exceeds what the identity&apos;s stewards hold; the gateway refuses one that would.</p>
      </div>
    </Modal>
  );
}

/** an identity's PUBLIC credentials: list, add, revoke (never delete) */
function IdentityCredentials(props: {
  identity: WorkloadIdentityDetailView;
  busy: boolean;
  active: boolean;
  inactiveReason: string;
  onAdd: () => void;
  ask: (c: Confirmation) => void;
}) {
  const credentials = useQuery({ queryKey: workloadIdentityKeys.credentials(props.identity.id), queryFn: () => listIdentityCredentials(props.identity.id) });
  const now = Date.now();
  return (
    <>
      <div className={s.heading}>
        <h2>Public credentials</h2>
        {props.active ? (
          <Button disabled={props.busy} onClick={props.onAdd}>
            Add public credential
          </Button>
        ) : (
          <Unavailable label="Add public credential" reason={props.inactiveReason} />
        )}
      </div>
      <p>
        {props.identity.activeCredentialCount === 1 ? "1 credential is" : `${props.identity.activeCredentialCount} credentials are`} active
        (not revoked, not expired). Only public halves are registered; private keys stay with the workload. An in-process agent
        uses its grant directly and needs none.
      </p>
      {credentials.isError ? (
        <ErrorState message="Public credentials could not be read. No empty list is inferred." onRetry={() => void credentials.refetch()} />
      ) : (
        <Table<WorkloadCredentialView>
          rows={credentials.data?.items}
          loading={credentials.isPending}
          rowKey={(c) => c.id}
          empty={<EmptyState title="No public credentials" body="Nothing can sign in as this identity from outside the gateway." />}
          columns={[
            { key: "kind", header: "Kind", render: (c) => credentialKindLabels[c.kind] ?? c.kind },
            { key: "fact", header: "Public fact", render: (c) => <span className={s.identifier}>{credentialFact(c)}</span> },
            { key: "until", header: "Valid until", render: (c) => dateLabel(c.notAfter) },
            {
              key: "state",
              header: "Status",
              render: (c) => {
                const state = credentialState(c, now);
                return <Badge tone={state === "live" ? "ok" : state === "revoked" ? "danger" : "neutral"}>{state}</Badge>;
              },
            },
            {
              key: "revoke",
              header: "Revoke",
              render: (c) =>
                c.revokedAt !== null ? (
                  <Unavailable size="sm" label="Revoke credential" reason="This credential is already revoked; a revoked credential is never revived." />
                ) : (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={props.busy}
                    aria-label={`Revoke ${credentialKindLabels[c.kind] ?? c.kind} ${credentialFact(c)}`}
                    onClick={() =>
                      props.ask({
                        title: "Revoke public credential?",
                        label: "Revoke credential",
                        danger: true,
                        okMessage: "Credential revoked.",
                        body: "Every token this credential authenticated, or that is bound to its key, is refused, and so is every delegation grant it authenticated with their descendants. A revoked credential is never revived; register a new key instead.",
                        run: () => revokeIdentityCredential(props.identity.id, c.id),
                      })
                    }
                  >
                    Revoke
                  </Button>
                ),
            },
          ]}
        />
      )}
    </>
  );
}


/**
 * OWNER DECISION 1: proposals from observed use, accepted only through the grant-set replace. Least privilege
 * (security review Medium 3): only allowed calls and the agent's own allow-list refusals are evidence; a proposal that
 * never ran (refusal only) is never pre-selected, and is added only by ticking it.
 */
function GrantProposals(props: { identity: WorkloadIdentityDetailView; busy: boolean; targetName: (id: string) => string; ask: (c: Confirmation) => void }) {
  const [requested, setRequested] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const proposals = useQuery({
    queryKey: workloadIdentityKeys.proposals(props.identity.id),
    queryFn: () => getGrantProposals(props.identity.id),
    enabled: requested,
  });
  const data = proposals.data;
  // a fresh read resets the selection to the safe default
  useEffect(() => {
    if (data) setSelected(defaultProposalSelection(data.proposals));
  }, [data]);
  const chosen = data ? data.proposals.filter((p) => p.heldByStewards && selected.has(proposalKey(p))) : [];
  const toggle = (key: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    setSelected(next);
  };
  return (
    <>
      <div className={s.heading}>
        <h2>Proposed grants from observed use</h2>
        <Button disabled={props.busy || proposals.isFetching} onClick={() => (requested ? void proposals.refetch() : setRequested(true))}>
          {requested ? "Refresh proposals" : "Propose grants from observed use"}
        </Button>
      </div>
      <p>
        Built from this identity&apos;s calls in the last 30 days that were allowed, or refused only because it lacked its own grant.
        Calls refused for any other reason are never proposed. Reading proposals changes nothing. Only what a steward holds can be
        accepted, and a proposal that never ran is added only if you tick it.
      </p>
      {!requested ? null : proposals.isPending ? (
        <SkeletonBlock lines={3} />
      ) : proposals.isError || !data ? (
        <ErrorState message="Proposals could not be read. Nothing is proposed." onRetry={() => void proposals.refetch()} />
      ) : (
        <>
          <Table<IdentityGrantProposal>
            rows={data.proposals}
            rowKey={proposalKey}
            empty={<EmptyState title="Nothing to propose" body="Every call observed in the window is already covered by this identity's own grants." />}
            columns={[
              {
                key: "include",
                header: "Include",
                render: (p) =>
                  p.heldByStewards ? (
                    <input
                      type="checkbox"
                      checked={selected.has(proposalKey(p))}
                      aria-label={`Include ${proposalLabel(p.grant)} on ${props.targetName(proposalTargetId(p.grant))}`}
                      onChange={(e) => toggle(proposalKey(p), e.target.checked)}
                    />
                  ) : (
                    "Not available"
                  ),
              },
              { key: "grant", header: "Grant", render: (p) => proposalLabel(p.grant) },
              { key: "target", header: "Target", render: (p) => props.targetName(proposalTargetId(p.grant)) },
              {
                key: "observed",
                header: "Observed",
                render: (p) => (
                  <>
                    {p.observedCalls} call(s), {p.refusedCalls} refused; last {dateLabel(p.lastObservedAt)}
                    {p.refusalOnly && <div>Never ran: every call was refused for lack of this grant.</div>}
                  </>
                ),
              },
              {
                key: "held",
                header: "Stewards",
                render: (p) => (p.heldByStewards ? <Badge tone="ok">held</Badge> : <Badge tone="warn">no steward holds it</Badge>),
              },
            ]}
          />
          {data.unproposable > 0 && <p>{data.unproposable} observed call(s) cannot become an own grant (for example a connector call that named no object).</p>}
          {data.truncated && <p>Only the most recent proposals are shown.</p>}
          {chosen.length === 0 ? (
            <Unavailable label="Accept proposals" reason="No proposal is selected, so accepting would change nothing." />
          ) : (
            <Button
              variant="primary"
              disabled={props.busy}
              onClick={() => {
                const next = setWithProposals(data.currentSet, data.proposals, selected);
                props.ask({
                  title: "Accept proposed grants?",
                  label: "Accept proposals",
                  danger: false,
                  okMessage: "Proposed grants accepted.",
                  body: `Adds the ${chosen.length} selected grant(s)${chosen.some((p) => p.refusalOnly) ? ", including some this identity has never been allowed to use" : ""}. This replaces all of the identity's direct grants and roles at revision ${data.revision}; if another change landed first, nothing is replaced.`,
                  run: () => replaceIdentityGrants(props.identity.id, next),
                });
              }}
            >
              Accept proposals
            </Button>
          )}
        </>
      )}
    </>
  );
}


function CreateIdentityDialog(props: { onClose: () => void; onSave: (body: CreateWorkloadIdentityBody, what: string) => void }) {
  const pickers = useQuery({ queryKey: workloadIdentityKeys.pickers, queryFn: getIdentityPickerSources });
  const cutNotice = pickers.data ? pickerTruncationNotice(pickers.data) : null;
  const [kind, setKind] = useState<WorkloadIdentityKind>("worker_runtime");
  const [subjectId, setSubjectId] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [stewards, setStewards] = useState<string[]>([]);
  const [stewardChoice, setStewardChoice] = useState("");
  const [environments, setEnvironments] = useState<string[]>([]);
  const [envChoice, setEnvChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const column = SUBJECT_COLUMN[kind];
  const subjects = kind === "agent" || kind === "builder_agent" || kind === "engine_runner" ? pickers.data?.subjects[kind] ?? [] : [];
  const sponsors = pickers.data?.sponsors ?? [];
  const sponsorLabel = (id: string) => sponsors.find((p) => p.id === id)?.label ?? id;

  const save = () => {
    const out = createIdentityBody({ kind, subjectId, identifier, stewardIds: stewards, environments });
    if ("error" in out) return setError(out.error);
    const subject = subjects.find((x) => x.id === subjectId)?.label;
    props.onSave(out.body, `an identity for the ${workloadKindLabels[kind].toLowerCase()}${subject ? ` ${subject}` : ""}`);
  };

  return (
    <Modal
      open
      title="Add workload identity"
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!pickers.data} onClick={save}>
            Review identity
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        {error && <p role="alert">{error}</p>}
        {pickers.isError && <ErrorState message="The choices for this form could not be read. Nothing can be created until they load." onRetry={() => void pickers.refetch()} />}
        {cutNotice && <p>{cutNotice}</p>}
        <Field label="Kind">
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as WorkloadIdentityKind);
              setSubjectId("");
              setIdentifier("");
              setError(null);
            }}
          >
            {WORKLOAD_IDENTITY_KINDS.map((k) => (
              <option key={k} value={k}>
                {workloadKindLabels[k]}
              </option>
            ))}
          </Select>
        </Field>
        {column && (
          <Field label="For" help="Only subjects that have no identity yet are offered; each has at most one, ever.">
            <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              <option value="">{pickers.isPending ? "Loading…" : subjects.length ? "Choose one" : "None without an identity"}</option>
              {subjects.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {EXTERNAL_IDENTITY_KINDS.includes(kind) && (
          <Field label="SPIFFE ID (optional)" help="Leave empty for the default identifier. Enter an exact ID only when your own SPIRE issues it.">
            <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
        )}
        <fieldset>
          <legend>Stewards</legend>
          {stewards.length > 0 && (
            <ul className={s.chips} aria-label="Chosen stewards">
              {stewards.map((id) => (
                <li key={id} className={s.chip}>
                  {sponsorLabel(id)}
                  <Button size="sm" variant="ghost" aria-label={`Remove steward ${sponsorLabel(id)}`} onClick={() => setStewards(stewards.filter((x) => x !== id))}>
                    ×
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className={s.actions}>
            <Field label="Add a steward" help={`At least one, at most ${WORKLOAD_IDENTITY_MAX_STEWARDS}. Only enabled people are offered.`}>
              <Select value={stewardChoice} onChange={(e) => setStewardChoice(e.target.value)}>
                <option value="">Choose a person</option>
                {sponsors
                  .filter((p) => !stewards.includes(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} · {p.email}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button
              disabled={!stewardChoice}
              onClick={() => {
                setStewards([...stewards, stewardChoice]);
                setStewardChoice("");
              }}
            >
              Add steward
            </Button>
          </div>
        </fieldset>
        <fieldset>
          <legend>Allowed environments</legend>
          {environments.length === 0 ? (
            <p>None allowed: the identity is refused in every environment until one is added.</p>
          ) : (
            <ul className={s.chips} aria-label="Chosen environments">
              {environments.map((env) => (
                <li key={env} className={s.chip}>
                  <code>{env}</code>
                  <Button size="sm" variant="ghost" aria-label={`Remove environment ${env}`} onClick={() => setEnvironments(environments.filter((x) => x !== env))}>
                    ×
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className={s.actions}>
            <Field label="Add an environment" help="The names in use on this gateway. Add others later with Edit stewards and environments.">
              <Select value={envChoice} onChange={(e) => setEnvChoice(e.target.value)}>
                <option value="">Choose an environment</option>
                {(pickers.data?.environments ?? [])
                  .filter((env) => !environments.includes(env))
                  .map((env) => (
                    <option key={env} value={env}>
                      {env}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button
              disabled={!envChoice}
              onClick={() => {
                setEnvironments([...environments, envChoice]);
                setEnvChoice("");
              }}
            >
              Add environment
            </Button>
          </div>
        </fieldset>
        <p>A new identity has no grants of its own, and its grants never exceed what its stewards hold.</p>
      </div>
    </Modal>
  );
}

function CredentialDialog(props: { onClose: () => void; onSave: (body: Parameters<typeof addIdentityCredential>[1], what: string) => void }) {
  const [draft, setDraft] = useState<CredentialDraft>({ kind: "jwk", jwkText: "", certificatePem: "", selfSigned: false, spiffeId: "", notAfterDate: "" });
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const out = credentialBody(draft, Date.now());
    if ("error" in out) return setError(out.error);
    props.onSave(out.body, `a ${credentialKindLabels[draft.kind].toLowerCase()}`);
  };
  return (
    <Modal
      open
      title="Add public credential"
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Review credential
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        {error && <p role="alert">{error}</p>}
        <p>Paste only the public half. A private key is refused before anything is sent.</p>
        <Field label="Credential kind">
          <Select
            value={draft.kind}
            onChange={(e) => {
              setDraft({ ...draft, kind: e.target.value as WorkloadCredentialKind });
              setError(null);
            }}
          >
            {WORKLOAD_CREDENTIAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {credentialKindLabels[k]}
              </option>
            ))}
          </Select>
        </Field>
        {draft.kind === "jwk" && (
          <Field label="Public key (JSON Web Key)" help="An Ed25519 (OKP) or P-256 (EC) public key.">
            <Textarea rows={5} value={draft.jwkText} onChange={(e) => setDraft({ ...draft, jwkText: e.target.value })} spellCheck={false} />
          </Field>
        )}
        {draft.kind === "x509" && (
          <>
            <Field label="Certificate (PEM)" help="The workload's own client certificate; only its fingerprint, URI SAN and subject are kept.">
              <Textarea rows={8} value={draft.certificatePem} onChange={(e) => setDraft({ ...draft, certificatePem: e.target.value })} spellCheck={false} />
            </Field>
            <label>
              <input type="checkbox" checked={draft.selfSigned} onChange={(e) => setDraft({ ...draft, selfSigned: e.target.checked })} /> Self-signed (matched by
              fingerprint, no CA chain)
            </label>
          </>
        )}
        {draft.kind === "spiffe_id" && (
          <Field label="SPIFFE ID" help="It signs in only when the gateway has a trust bundle for its trust domain.">
            <Input value={draft.spiffeId} onChange={(e) => setDraft({ ...draft, spiffeId: e.target.value })} autoComplete="off" spellCheck={false} />
          </Field>
        )}
        <Field label="Valid until (optional)" help={`Empty: the longest the gateway allows, at most ${WORKLOAD_CREDENTIAL_MAX_DAYS} days and never past a certificate's own expiry.`}>
          <Input type="date" value={draft.notAfterDate} onChange={(e) => setDraft({ ...draft, notAfterDate: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
