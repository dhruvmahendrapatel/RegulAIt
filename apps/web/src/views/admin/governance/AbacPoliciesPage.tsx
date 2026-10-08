/**
 * ABAC / policy-as-code (ADR-0040).
 *
 * Where an attribute-conditional policy is written, validated, tested,
 * activated and rolled back. Four things this screen exists to keep honest —
 * they are the ADR's invariants, rendered rather than merely documented:
 *
 *  - **ABAC can only take away.** The header says it, the editor says it, and
 *    the server proves it: a Cedar `permit` is refused at write time. There is
 *    no control here that widens access, because there is no such thing.
 *  - **Validation is at WRITE time.** A policy naming an attribute the schema
 *    does not declare never gets stored, and the reason is shown against the
 *    editor rather than discovered later as a policy that quietly matched
 *    nothing. The schema itself is on the page, so an author is never guessing.
 *  - **Activation is the dangerous act, not authoring.** Creating a policy
 *    leaves it inactive; a separate, audited Activate is what starts denying
 *    real calls. The blast radius is one click away in Simulation — this is the
 *    ADR's "friction, not a one-click default".
 *  - **History is not lost.** Every version is listed and re-activatable, so a
 *    rollback is choosing an older row rather than editing the current one back.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type {
  AbacPolicySummary,
  AbacPolicyDetail,
  AbacSchemaInfo,
  AbacTestRun,
  AbacValidation,
} from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Textarea,
} from "../../../ui/kit";
import { QueryGate, optionEls, useAction, useUsers, userOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";

const STARTER = `forbid (
  principal,
  action == RegulAIt::Action::"McpToolCall",
  resource
) when {
  resource.kind == "write" &&
  resource.classifications.contains("hipaa") &&
  (context.hour >= 22 || context.hour < 6)
};`;

export default function AbacPoliciesPage() {
  const users = useUsers();
  const schema = useQuery({
    queryKey: ["admin", "abac-schema"],
    queryFn: () => api.get<AbacSchemaInfo>("/v1/abac/schema"),
  });
  const policies = useQuery({
    queryKey: ["admin", "abac-policies"],
    queryFn: () =>
      api.get<{ policies: AbacPolicySummary[]; engine: string; activeCount: number }>(
        "/v1/abac/policies",
      ),
  });

  const act = useAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState(STARTER);
  const [mode, setMode] = useState<"forbid" | "require_approval">("forbid");
  const [timezone, setTimezone] = useState("UTC");
  const [approverUserId, setApproverUserId] = useState("");
  const [validation, setValidation] = useState<AbacValidation | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AbacPolicySummary | null>(null);

  const rows = policies.data?.policies ?? [];
  const activeCount = policies.data?.activeCount ?? 0;

  return (
    <>
      <PageHeader
        title="ABAC policies"
        sub="Attribute-conditional policy that can narrow a decision, never widen it."
        info={<p>Attribute-conditional policy, evaluated inside the same kernel and recorded in the same audit trail as every RBAC decision. A policy can only DENY or PAUSE a call the entitlement model already allows — it can never grant one, and with no active policy the kernel decides exactly as it did before.</p>}
      />
      <div className={v.stack}>
        <Card title="Write a policy">
          <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
            {activeCount === 0
              ? "No policy is active. Every governed call is decided by the entitlement model alone — exactly as it was before this feature existed."
              : `${activeCount} active ${activeCount === 1 ? "policy" : "policies"}. Each one can only further restrict a call the entitlement model allows.`}
            {policies.data?.engine ? ` Engine: ${policies.data.engine}.` : ""}
          </div>
          <form
            className={v.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(async () => {
                const created = await api.post<{ policy: AbacPolicySummary }>("/v1/abac/policies", {
                  name: name.trim(),
                  description: description.trim() || null,
                  source,
                  mode,
                  timezone: timezone.trim() || "UTC",
                  approverUserId: mode === "require_approval" ? approverUserId : null,
                });
                setName("");
                setDescription("");
                setValidation(null);
                setSelected(created.policy.id);
              }, "Policy created — inactive until you activate a version");
            }}
          >
            <div className={a.formRow}>
              <Field label="Name" grow>
                <Input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="no-night-hipaa-writes"
                />
              </Field>
              <Field label="When it matches">
                <Select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "forbid" | "require_approval")}
                >
                  <option value="forbid">Deny the call</option>
                  <option value="require_approval">Pause for approval</option>
                </Select>
              </Field>
              <Field label="Timezone (times are read in THIS zone)">
                <Input
                  required
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="UTC"
                />
              </Field>
              {mode === "require_approval" && (
                <Field label="Approver">
                  <Select
                    required
                    value={approverUserId}
                    onChange={(e) => setApproverUserId(e.target.value)}
                  >
                    {optionEls(userOpts(users.data?.users), "— who signs off —")}
                  </Select>
                </Field>
              )}
            </div>
            <Field label="What it is for (shown in the denial reason)" grow>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="no write-capable tool against a HIPAA project overnight"
              />
            </Field>
            <Field label="Cedar policy" grow>
              <Textarea
                required
                rows={10}
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setValidation(null);
                }}
                spellCheck={false}
                style={{ fontFamily: "var(--font-mono, monospace)" }}
              />
            </Field>
            <div className={v.row}>
              <Button
                type="button"
                disabled={act.busy}
                onClick={() =>
                  void act.run(async () => {
                    setValidation(await api.post<AbacValidation>("/v1/abac/validate", { source }));
                  }, null)
                }
              >
                Validate
              </Button>
              <Button type="submit" variant="primary" disabled={act.busy}>
                Create policy
              </Button>
              <span className={v.faint}>
                A new policy starts INACTIVE. Activating a version is a separate, audited step.
              </span>
            </div>
          </form>
          {validation && (
            <div style={{ marginTop: "var(--s2)" }}>
              {validation.ok ? (
                <Badge tone="ok">Valid against schema {schema.data?.current}</Badge>
              ) : (
                <div className={v.errLine} role="alert">
                  {validation.errors.map((e, i) => (
                    <div key={i}>
                      {e.message}
                      {e.help ? ` — ${e.help}` : ""}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {act.error && (
            <div className={v.errLine} role="alert" style={{ marginTop: "var(--s2)" }}>
              {act.error}
            </div>
          )}
        </Card>

        <QueryGate
          loading={policies.isLoading}
          error={policies.error}
          onRetry={() => void policies.refetch()}
        >
          <Card title="Policies">
            <Table
              rows={rows}
              rowKey={(p) => p.id}
              empty={
                <EmptyState
                  title="No ABAC policies"
                  body="Every governed call is decided by the entitlement model alone. Write a policy above to add an attribute condition on top of it."
                />
              }
              onRowClick={(p) => setSelected(p.id === selected ? null : p.id)}
              columns={[
                { key: "name", header: "Name", render: (p) => p.name, sort: (p) => p.name },
                {
                  key: "state",
                  header: "State",
                  render: (p) =>
                    p.enabled && p.activeVersionId ? (
                      <Badge tone="ok">active · v{p.activeVersion}</Badge>
                    ) : (
                      <Badge tone="neutral">inactive</Badge>
                    ),
                },
                {
                  key: "mode",
                  header: "On match",
                  render: (p) =>
                    p.mode === "require_approval" ? (
                      <Badge tone="warn">pause for approval</Badge>
                    ) : p.mode ? (
                      <Badge tone="danger">deny</Badge>
                    ) : (
                      <span className={v.dim}>—</span>
                    ),
                },
                { key: "tz", header: "Timezone", render: (p) => p.timezone ?? "—" },
                {
                  key: "created",
                  header: "Created",
                  render: (p) => ago(p.createdAt),
                  sort: (p) => p.createdAt,
                },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  render: (p) => (
                    <div className={v.rowTight}>
                      {p.enabled && (
                        <Button
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            void act.run(
                              () => withStepUp((h) => stepUpApi.post(`/v1/abac/policies/${p.id}/deactivate`, {}, h)),
                              "Deactivated",
                            );
                          }}
                        >
                          Deactivate
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(p);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        </QueryGate>

        {selected && <PolicyDetail policyId={selected} />}

        <Card title="The attribute schema a policy may reference">
          <p className={v.faint}>
            Anything not declared here is a validation error at write time — never a policy that
            silently matches nothing. Times are read in the zone the policy declares, not this
            server's.
          </p>
          <CodeBlock maxHeight="320px">{schema.data?.schemaText ?? "loading…"}</CodeBlock>
        </Card>
      </div>

      <ConfirmModal
        open={confirmDelete !== null}
        title={`Delete '${confirmDelete?.name ?? ""}'?`}
        body="Every version of this policy is removed and it stops being evaluated. Decisions it already made stay in the audit log — that is the record that matters. Deactivating instead keeps the history here."
        confirmLabel="Delete policy"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const target = confirmDelete;
          setConfirmDelete(null);
          if (target) {
            void act.run(() => withStepUp((h) => api.delWithHeaders(`/v1/abac/policies/${target.id}`, h)), "Policy deleted");
          }
        }}
      />
    </>
  );
}

/** Version history + activate/rollback + the test runner, for one policy. */
function PolicyDetail(props: { policyId: string }) {
  const act = useAction();
  const [testRun, setTestRun] = useState<AbacTestRun | null>(null);
  const detail = useQuery({
    queryKey: ["admin", "abac-policy", props.policyId],
    queryFn: () => api.get<AbacPolicyDetail>(`/v1/abac/policies/${props.policyId}`),
  });

  const activeVersionId = detail.data?.policy.activeVersionId ?? null;
  const versions = detail.data?.versions ?? [];

  return (
    <QueryGate
      loading={detail.isLoading}
      error={detail.error}
      onRetry={() => void detail.refetch()}
    >
      <Card title={`Versions — ${detail.data?.policy.name ?? ""}`}>
        <p className={v.faint}>
          Editing a policy adds a version; it never overwrites one. Rolling back is activating an
          older version, so the version you rolled away from is still here and still re-activatable.
        </p>
        <Table
          rows={versions}
          rowKey={(x) => x.id}
          empty={<EmptyState title="No versions" />}
          columns={[
            {
              key: "version",
              header: "Version",
              render: (x) => (
                <span className={v.rowTight}>
                  <span className={v.mono}>v{x.version}</span>
                  {x.id === activeVersionId && <Badge tone="ok">active</Badge>}
                </span>
              ),
              sort: (x) => x.version,
            },
            {
              key: "mode",
              header: "On match",
              render: (x) => (x.mode === "require_approval" ? "pause for approval" : "deny"),
            },
            { key: "tz", header: "Timezone", render: (x) => x.timezone },
            { key: "schema", header: "Schema", render: (x) => x.schemaVersion },
            {
              key: "tests",
              header: "Tests",
              render: (x) => (x.testCases?.length ? `${x.testCases.length}` : "—"),
            },
            { key: "created", header: "Added", render: (x) => ago(x.createdAt) },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (x) => (
                <div className={v.rowTight}>
                  <Button
                    size="sm"
                    disabled={x.id === activeVersionId || act.busy}
                    onClick={() =>
                      void act.run(async () => {
                        await api.post(`/v1/abac/policies/${props.policyId}/activate`, {
                          version: x.version,
                        });
                        await detail.refetch();
                      }, `v${x.version} activated`)
                    }
                  >
                    {x.id === activeVersionId ? "Active" : "Activate"}
                  </Button>
                  <Button
                    size="sm"
                    disabled={act.busy}
                    onClick={() =>
                      void act.run(async () => {
                        setTestRun(
                          await api.post<AbacTestRun>(
                            `/v1/abac/policies/${props.policyId}/test`,
                            { version: x.version },
                          ),
                        );
                      }, null)
                    }
                  >
                    Run tests
                  </Button>
                </div>
              ),
            },
          ]}
        />
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        {testRun && (
          <div style={{ marginTop: "var(--s2)" }}>
            <div className={v.row}>
              <Badge tone={testRun.failed === 0 ? "ok" : "danger"}>
                v{testRun.version}: {testRun.passed}/{testRun.total} passed
              </Badge>
            </div>
            {testRun.results.map((r, i) => (
              <div key={i} className={v.row}>
                <Badge tone={r.passed ? "ok" : "danger"}>{r.passed ? "pass" : "fail"}</Badge>
                <span>{r.name}</span>
                <span className={v.faint}>
                  expected {r.expected}, got {r.actual}
                </span>
              </div>
            ))}
          </div>
        )}
        {versions.length > 0 && (
          <details style={{ marginTop: "var(--s2)" }}>
            <summary className={v.dim} style={{ cursor: "pointer" }}>
              Source of every version
            </summary>
            <div style={{ marginTop: "var(--s1)" }}>
              {versions.map((x) => (
                <div key={x.id} style={{ marginTop: "var(--s2)" }}>
                  <div className={v.mono}>v{x.version}</div>
                  <CodeBlock maxHeight="220px">{x.source}</CodeBlock>
                </div>
              ))}
            </div>
          </details>
        )}
      </Card>
    </QueryGate>
  );
}
