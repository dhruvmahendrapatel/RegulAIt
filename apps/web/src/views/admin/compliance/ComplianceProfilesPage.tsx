/**
 * Compliance profiles (§8.3) — policy-as-code: one tag cascades required
 * workflow templates, MCP default mode, audit/backup retention, patch cadence
 * and PII mode onto everything a classified project governs. Includes the
 * live cascade preview for any project (with how multiple tags compose — the
 * strictest wins per dimension) and the governed reclassification flow.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import { withStepUp } from "../../../stepup/stepUp";
import type {
  ComplianceProfile,
  ComplianceProfileCarriedFloors,
  ComplianceProfileRecord,
  ComplianceProfileUsage,
  ProjectCompliance,
  WorkflowTemplate,
} from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, CodeBlock, EmptyState, Field, InfoButton, Input, RowActions, Select, Table } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { reachSentence } from "./profileReach";
import sh from "../governance/shadowAi.module.css";
import {
  KV,
  ReasonModal,
  optionEls,
  projectOpts,
  useAction,
  useAdminInvalidate,
  useComplianceProfiles,
  useProjects,
  useUsers,
  userOpts,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export default function ComplianceProfilesPage() {
  const profiles = useComplianceProfiles();
  const templates = useQuery({
    queryKey: ["admin", "wf-templates"],
    queryFn: () => api.get<{ templates: WorkflowTemplate[] }>("/v1/workflows/templates"),
  });
  const tplName = new Map((templates.data?.templates ?? []).map((t) => [t.id, t.name]));
  // ADR-0208 (G7): row actions, the Active / Retired filter, and retire with its in-use refusal
  const all = profiles.data?.profiles ?? [];
  const [filter, setFilter] = useState<"active" | "retired">("active");
  const rows = all.filter((p) => p.status === filter);
  const [editing, setEditing] = useState<ComplianceProfileRecord | null>(null);
  const [retiring, setRetiring] = useState<ComplianceProfileRecord | null>(null);
  const [retireRefusal, setRetireRefusal] = useState<string | null>(null);
  const { toast } = useToast();
  const invalidate = useAdminInvalidate();

  return (
    <>
      <PageHeader
        title="Compliance profiles"
        sub="One classification tag, cascaded into policy everywhere it applies."
        info={<p>A single classification tag on a project cascades required workflow stages, MCP data-scope defaults, audit-log retention, PII handling and infra floors — policy-as-code, one tag.</p>}
      />
      <div className={v.stack}>
        <Card
          flush
          title="Profiles"
          actions={
            <div className={v.row} role="group" aria-label="Filter by status">
              {(["active", "retired"] as const).map((g) => (
                <button key={g} type="button" className={sh.chip} aria-pressed={filter === g} onClick={() => setFilter(g)}>
                  {g === "active" ? "Active" : "Retired"} {all.filter((p) => p.status === g).length}
                </button>
              ))}
            </div>
          }
        >
          <Table<ComplianceProfileRecord>
            columns={[
              {
                key: "tag",
                header: "Tag",
                sort: (p) => p.tag,
                render: (p) => (
                  <span className={v.row}>
                    <Badge tone={p.status === "retired" ? "neutral" : "info"}>{p.tag}</Badge>
                    <span className={v.faint}>v{p.version}</span>
                    {p.pendingReview && <Badge tone="warn">v{p.pendingReview.version} in review</Badge>}
                    {p.status === "retired" && <Badge tone="neutral">retired</Badge>}
                  </span>
                ),
              },
              {
                key: "templates",
                header: "Required templates",
                render: (p) =>
                  (p.requiredTemplateIds ?? []).map((id) => tplName.get(id) ?? id.slice(0, 8) + "…").join(", ") ||
                  "—",
              },
              { key: "mcp", header: "MCP default", render: (p) => p.mcpDefaultMode },
              { key: "pii", header: "PII mode", render: (p) => p.piiMode },
              {
                key: "audit",
                header: "Audit retention",
                align: "right",
                render: (p) => (p.auditRetentionDays != null ? `${p.auditRetentionDays}d` : "—"),
              },
              {
                key: "backup",
                header: "Backup floor",
                align: "right",
                render: (p) => (p.backupRetentionDays != null ? `${p.backupRetentionDays}d` : "—"),
              },
              {
                key: "patch",
                header: "Patch ceiling",
                align: "right",
                render: (p) => (p.patchCadenceDays != null ? `${p.patchCadenceDays}d` : "—"),
              },
              {
                key: "reach",
                header: "Applies to",
                render: (p) =>
                  p.status === "retired" ? (
                    <span className={v.faint}>nothing (retired)</span>
                  ) : (
                    <span title={reachSentence(p.usage)}>
                      {p.usage.projects.length + p.usage.pendingProjects.length} proj · {p.usage.teams.length} team · {p.usage.resources.length} infra
                    </span>
                  ),
              },
              {
                key: "actions",
                header: "Actions",
                render: (p) =>
                  p.status === "retired" ? (
                    <span className={v.faint}>Read-only{p.retiredAt ? ` · retired ${p.retiredAt.slice(0, 10)}` : ""}</span>
                  ) : (
                    <RowActions
                      slot="8rem"
                      primary={
                        // one review at a time: a pending change is decided in Approvals first
                        <Button size="sm" variant="primary" disabled={!!p.pendingReview} aria-label={`Edit profile ${p.tag}`} onClick={() => setEditing(p)}>
                          Edit profile
                        </Button>
                      }
                      rest={
                        carrierCount(p.usage) > 0 ? (
                          <span data-testid={`retire-blocked-${p.tag}`} className={v.row} style={{ flexWrap: "wrap", maxWidth: "14rem" }}>
                            <Button size="sm" disabled aria-describedby={`retire-why-${p.tag}`}>
                              Retire
                            </Button>
                            <span id={`retire-why-${p.tag}`} className={v.faint}>
                              In use by {reachSentence(p.usage, true)}
                            </span>
                            <InfoButton label={`what uses ${p.tag}`} term="What carries this tag" align="end">
                              <span>Reclassify these first, then retire it:</span>
                              <CarrierList usage={p.usage} />
                            </InfoButton>
                          </span>
                        ) : (
                          <Button size="sm" variant="ghost" aria-label={`Retire ${p.tag}`} onClick={() => setRetiring(p)}>
                            Retire
                          </Button>
                        )
                      }
                    />
                  ),
              },
            ]}
            rows={rows}
            rowKey={(p) => p.tag}
            loading={profiles.isLoading}
            error={profiles.error}
            onRetry={() => void profiles.refetch()}
            empty={
              <EmptyState
                title={`No ${filter} profiles`}
                body="Define a framework below; its tag then becomes assignable to projects, teams and infra resources."
              />
            }
          />
        </Card>

        {editing && (
          <Suspense fallback={null}>
            <ProfileEditModal profile={editing} templates={(templates.data?.templates ?? []).filter((t) => !t.retiredAt)} onClose={() => setEditing(null)} />
          </Suspense>
        )}
        <ReasonModal
          open={retiring !== null}
          danger
          minLength={10}
          title={`Retire profile “${retiring?.tag ?? ""}”?`}
          confirmLabel="Retire profile"
          body={
            <>
              <p className={v.flush}>
                No project, team or resource can be tagged ‘{retiring?.tag}’ any more. Its versions and audit history are kept, and the audit
                retention it set is kept as a floor. You will be asked to confirm it's you.
              </p>
              {retireRefusal && (
                <div className={v.errLine} role="alert">
                  {retireRefusal}
                </div>
              )}
            </>
          }
          onCancel={() => {
            setRetiring(null);
            setRetireRefusal(null);
          }}
          onConfirm={(reason) => {
            const p = retiring;
            if (!p) return;
            setRetireRefusal(null);
            void (async () => {
              try {
                await withStepUp((h) => api.postWithHeaders(`/v1/compliance/profiles/${p.id}/retire`, { reason }, h));
                setRetiring(null);
                toast(`Profile “${p.tag}” retired`, "success");
                invalidate();
              } catch (e) {
                // the dialog stays open with the typed reason; the refusal says what to do next
                setRetireRefusal(retireRefusalText(e));
              }
            })();
          }}
        />
        <UpsertProfileCard
          templates={templates.data?.templates ?? []}
          profiles={all}
          profilesLoading={profiles.data === undefined && !profiles.error}
          profilesFailed={!!profiles.error}
        />
        <CascadePreviewCard />
        <ReclassifyCard />
      </div>
    </>
  );
}

/** the profile fields this form does not show: an update sends them back as they are, because the route replaces the
 * whole profile and an omitted floor would otherwise be cleared (#602; the server now also keeps an omitted field) */
const CARRIED: ReadonlyArray<keyof ComplianceProfileCarriedFloors> = [
  "maxProjectBudgetUsd",
  "budgetEnforcement",
  "guardrailModes",
  "redteamGatingClasses",
  "redteamMinTrials",
  "redteamFailOnSeverity",
  "minIsolationClass",
];

// ADR-0181: a new profile starts at the strict defaults (read_only, block), the same as the server's
const EMPTY_FORM = {
  tag: "",
  requiredTemplateIds: [] as string[],
  mcpDefaultMode: "read_only",
  piiMode: "block",
  auditRetentionDays: "",
  backupRetentionDays: "",
  patchCadenceDays: "",
};

const numText = (n: number | null | undefined) => (n == null ? "" : String(n));

const formFrom = (p: ComplianceProfile, tag: string) => ({
  tag,
  requiredTemplateIds: p.requiredTemplateIds ?? [],
  mcpDefaultMode: p.mcpDefaultMode,
  piiMode: p.piiMode,
  auditRetentionDays: numText(p.auditRetentionDays),
  backupRetentionDays: numText(p.backupRetentionDays),
  patchCadenceDays: numText(p.patchCadenceDays),
});

function UpsertProfileCard(props: {
  templates: WorkflowTemplate[];
  profiles: ComplianceProfileRecord[];
  profilesLoading: boolean;
  profilesFailed: boolean;
}) {
  const act = useAction();
  const [f, setF] = useState(EMPTY_FORM);
  // the tag whose stored profile is in the form; null while the form holds a new profile
  const [loadedTag, setLoadedTag] = useState<string | null>(null);
  const set = (k: keyof typeof f, val: string | string[]) => setF((s) => ({ ...s, [k]: val }));
  // until the list has loaded without error, an existing tag cannot be told apart from a new one
  const listReady = !props.profilesLoading && !props.profilesFailed;
  const match = listReady ? props.profiles.find((p) => p.tag === f.tag.trim()) : undefined;
  const existing = match && match.tag === loadedTag ? match : undefined;
  // typing an existing tag loads that profile, also when the list arrives after the tag was typed; moving off it
  // starts again from the strict defaults, so a new profile never inherits another profile's values
  useEffect(() => {
    if (match && match.tag !== loadedTag) {
      setF(formFrom(match, f.tag));
      setLoadedTag(match.tag);
    } else if (listReady && !match && loadedTag !== null) {
      setF({ ...EMPTY_FORM, tag: f.tag });
      setLoadedTag(null);
    }
  }, [listReady, match, loadedTag, f.tag]);
  // ADR-0208 (G7): this card only creates. An existing tag changes through Edit profile on its row (a reviewed
  // version), so submitting is off while the typed tag names a stored profile.
  const canSubmit = listReady && !match;
  const tplOpts = props.templates.filter((t) => !t.retiredAt);
  const activeIds = new Set(tplOpts.map((t) => t.id));
  const tplName = new Map(props.templates.map((t) => [t.id, t.name]));
  // retired (or unknown) templates the profile still requires stay required: they show disabled and the Select keeps them
  const keptIds = f.requiredTemplateIds.filter((id) => !activeIds.has(id));
  return (
    <Card
      title="New profile"
      info={
        <p>
          Creates a new tag at version 1, strict by default (MCP read only, PII blocked). A tag that already
          exists is refused: change it with Edit profile on its row, which creates the next version and waits
          for a reviewer. Retention floors compose longest-wins across profiles; patch cadence shortest-wins.
        </p>
      }
    >
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          void act.run(
            // ADR-0186 decision 29: loosening a stored profile needs a settings_relax step-up
            () =>
              withStepUp((h) =>
                api.postWithHeaders(
                  "/v1/compliance/profiles",
                  {
                    ...(existing ? Object.fromEntries(CARRIED.map((k) => [k, existing[k] ?? null])) : {}),
                    tag: f.tag.trim(),
                    ...(f.requiredTemplateIds.length ? { requiredTemplateIds: f.requiredTemplateIds } : {}),
                    mcpDefaultMode: f.mcpDefaultMode,
                    piiMode: f.piiMode,
                    auditRetentionDays: f.auditRetentionDays ? Number(f.auditRetentionDays) : null,
                    backupRetentionDays: f.backupRetentionDays ? Number(f.backupRetentionDays) : null,
                    patchCadenceDays: f.patchCadenceDays ? Number(f.patchCadenceDays) : null,
                  },
                  h,
                ),
              ),
            "Profile created at version 1",
          );
        }}
      >
        <Field label="Tag">
          <Input required value={f.tag} onChange={(e) => set("tag", e.target.value)} placeholder="for example hipaa" />
        </Field>
        <Field label="Required workflow templates (ctrl/cmd-click)">
          <Select
            multiple
            size={Math.min(4, Math.max(2, tplOpts.length + keptIds.length || 2))}
            value={f.requiredTemplateIds}
            onChange={(e) =>
              set("requiredTemplateIds", [
                ...keptIds,
                ...Array.from(e.target.selectedOptions)
                  .map((o) => o.value)
                  .filter((id) => activeIds.has(id)),
              ])
            }
          >
            {tplOpts.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            {keptIds.map((id) => (
              <option key={id} value={id} disabled>
                {(tplName.get(id) ?? id.slice(0, 8) + "…") + " (retired, stays required)"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="MCP default mode">
          <Select value={f.mcpDefaultMode} onChange={(e) => set("mcpDefaultMode", e.target.value)}>
            <option value="read_only">read only — write tools denied on attributed calls</option>
            <option value="read_write">read and write</option>
          </Select>
        </Field>
        <Field label="PII mode">
          <Select value={f.piiMode} onChange={(e) => set("piiMode", e.target.value)}>
            <option value="block">block — deny or withhold</option>
            <option value="warn">warn — proceed with a warning</option>
            <option value="log">log — record category counts</option>
          </Select>
        </Field>
        <Field label="Audit retention days (blank = none)">
          <Input type="number" value={f.auditRetentionDays} onChange={(e) => set("auditRetentionDays", e.target.value)} />
        </Field>
        <Field label="Backup retention days (infra floor)">
          <Input type="number" value={f.backupRetentionDays} onChange={(e) => set("backupRetentionDays", e.target.value)} />
        </Field>
        <Field label="Patch cadence days (infra ceiling)">
          <Input type="number" value={f.patchCadenceDays} onChange={(e) => set("patchCadenceDays", e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={act.busy || !canSubmit}>
          Create profile
        </Button>
        {props.profilesLoading && (
          <span className={v.hint} role="status">
            Loading the existing profiles, so a tag that already exists is not created twice.
          </span>
        )}
        {props.profilesFailed && (
          <span className={v.errLine} role="alert">
            The profiles list did not load, so creating is off: an existing tag would lose its floors. Retry the list above.
          </span>
        )}
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      {match && (
        <p className={v.hint} role="status">
          “{match.tag}” already exists{match.status === "retired" ? " and is retired (read-only)" : ""}. Its stored values are shown;
          {match.status === "retired" ? " a retired profile cannot change." : " change it with Edit profile on its row, which a reviewer approves."}
        </p>
      )}
    </Card>
  );
}

// ---- G7 helpers (ADR-0208) ---------------------------------------------------

const ProfileEditModal = lazy(() => import("./ProfileEditModal").then((m) => ({ default: m.ProfileEditModal })));

const carrierCount = (u: ComplianceProfileUsage) => u.projects.length + u.pendingProjects.length + u.teams.length + u.resources.length;

const CARRIER_GROUPS: Array<[keyof ComplianceProfileUsage, string]> = [
  ["projects", "Projects"],
  ["pendingProjects", "Projects waiting for a reclassification review"],
  ["teams", "Teams (default classification)"],
  ["resources", "Infrastructure resources"],
];

function CarrierList(props: { usage: ComplianceProfileUsage }) {
  return (
    <ul style={{ margin: "var(--s1) 0 0", paddingLeft: "var(--s3)" }}>
      {CARRIER_GROUPS.filter(([k]) => props.usage[k].length > 0).map(([k, label]) => (
        <li key={k}>
          {label}: {props.usage[k].join(", ")}
        </li>
      ))}
    </ul>
  );
}

function retireRefusalText(e: unknown): string {
  if (e instanceof ApiError && e.payload.error === "compliance_profile_in_use") {
    const u = e.payload as unknown as ComplianceProfileUsage;
    return `Still in use by ${reachSentence(u, true)}. Reclassify them first, then retire it.`;
  }
  if (e instanceof ApiError && e.payload.error === "compliance_profile_version_pending") {
    return "A change to this profile is waiting for review. Decide it in Approvals first.";
  }
  return e instanceof Error ? e.message : String(e);
}

// ---- cascade preview ------------------------------------------------------

function CascadePreviewCard() {
  const projects = useProjects();
  const act = useAction();
  const [projectId, setProjectId] = useState("");
  const [result, setResult] = useState<ProjectCompliance | null>(null);

  return (
    <Card title="Cascade preview — what a project's tags currently drive">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            setResult(await api.get<ProjectCompliance>(`/v1/projects/${projectId}/compliance`));
          }, null);
        }}
      >
        <Field label="Project" grow>
          <Select required value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {optionEls(projectOpts(projects.data?.projects), "— select a project —")}
          </Select>
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          Preview cascade
        </Button>
      </form>
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      {result && (
        <div className={v.stack} style={{ marginTop: "var(--s2)" }} data-testid="cascade-preview">
          <div className={v.row}>
            <span className={v.dim}>classifications:</span>
            {result.classifications.length === 0 && <span className={v.faint}>none</span>}
            {result.classifications.map((t) => (
              <Badge key={t} tone="primary">
                {t}
              </Badge>
            ))}
          </div>
          {result.pendingClassifications && result.pendingClassifications.length > 0 && (
            <div className={v.row}>
              <span className={v.dim}>pending reclassification:</span>
              {result.pendingClassifications.map((t) => (
                <Badge key={t} tone="warn">
                  {t}
                </Badge>
              ))}
            </div>
          )}
          {(result.profiles ?? []).length > 1 && (
            <p className={v.dim}>
              {result.profiles!.length} profiles compose here — per dimension the strictest wins (longest
              retention, read_only over read_write, block over warn over log). The effective row below is
              the merged result, so a conflict never silently loosens a framework.
            </p>
          )}
          <div className={v.sectionTitle}>Effective policy (cascaded)</div>
          <KV
            rows={[
              [
                "Required workflow templates",
                (result.effective.requiredTemplateIds ?? []).length
                  ? `${result.effective.requiredTemplateIds!.length} template(s)`
                  : "none",
              ],
              ["MCP default mode", result.effective.mcpDefaultMode ?? "—"],
              [
                "Audit retention (days)",
                result.effective.auditRetentionDays != null ? String(result.effective.auditRetentionDays) : "—",
              ],
              ["PII mode", result.effective.piiMode ?? "—"],
              [
                "Backup retention (days)",
                result.effective.backupRetentionDays != null ? String(result.effective.backupRetentionDays) : "—",
              ],
              [
                "Patch cadence (days)",
                result.effective.patchCadenceDays != null ? String(result.effective.patchCadenceDays) : "—",
              ],
            ]}
          />
          <div className={v.sectionTitle}>Enforcement — honest labels</div>
          <KV rows={Object.entries(result.enforcement).map(([k, val]) => [k, val])} />
          <details>
            <summary className={v.dim} style={{ cursor: "pointer" }}>
              Raw compliance JSON
            </summary>
            <div style={{ marginTop: "var(--s1)" }}>
              <CodeBlock maxHeight="280px">{JSON.stringify(result, null, 2)}</CodeBlock>
            </div>
          </details>
        </div>
      )}
    </Card>
  );
}

// ---- governed reclassification --------------------------------------------

function ReclassifyCard() {
  const projects = useProjects();
  const profiles = useComplianceProfiles();
  const users = useUsers();
  const act = useAction();
  const [projectId, setProjectId] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [reviewerUserId, setReviewer] = useState("");
  const [outcome, setOutcome] = useState<
    | { applied: true }
    | { pending: true; diff: unknown }
    | null
  >(null);
  const tagList = (profiles.data?.profiles ?? []).filter((p) => p.status !== "retired").map((p) => p.tag);

  return (
    <Card title="Classify / reclassify a project — never silent">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            const r = await api.post<{ applied?: boolean; pending?: boolean; diff?: unknown }>(
              `/v1/projects/${projectId}/classifications`,
              {
                classifications: tags,
                ...(reviewerUserId ? { reviewerUserId } : {}),
              },
            );
            setOutcome(r.applied ? { applied: true } : { pending: true, diff: r.diff });
          }, "Classification submitted");
        }}
      >
        <Field label="Project">
          <Select required value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {optionEls(projectOpts(projects.data?.projects), "— select —")}
          </Select>
        </Field>
        <Field label="New classifications (ctrl/cmd-click)">
          <Select
            multiple
            required
            size={Math.min(4, Math.max(2, tagList.length || 2))}
            value={tags}
            onChange={(e) => setTags(Array.from(e.target.selectedOptions).map((o) => o.value))}
          >
            {tagList.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reviewer (required for a CHANGE)">
          <Select value={reviewerUserId} onChange={(e) => setReviewer(e.target.value)}>
            {optionEls(userOpts(users.data?.users), "— none (first classification) —")}
          </Select>
        </Field>
        <Button type="submit" size="sm" variant="primary" disabled={act.busy}>
          Submit
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      {outcome && "applied" in outcome && (
        <p className={v.dim}>
          Applied directly — a FIRST classification has nothing in flight under an old cascade, so it takes
          effect immediately (audited).
        </p>
      )}
      {outcome && "pending" in outcome && (
        <div className={v.stack} style={{ marginTop: "var(--s2)" }}>
          <div className={v.row}>
            <Badge tone="warn">pending review</Badge>
            <span className={v.dim}>
              The change pends behind the named reviewer in the Approvals queue — the before/after cascade
              diff is attached, never applied silently.
            </span>
          </div>
          <CodeBlock maxHeight="240px">{JSON.stringify(outcome.diff, null, 2)}</CodeBlock>
        </div>
      )}
    </Card>
  );
}
