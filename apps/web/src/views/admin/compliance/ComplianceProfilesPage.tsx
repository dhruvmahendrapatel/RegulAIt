/**
 * Compliance profiles (§8.3) — policy-as-code: one tag cascades required
 * workflow templates, MCP default mode, audit/backup retention, patch cadence
 * and PII mode onto everything a classified project governs. Includes the
 * live cascade preview for any project (with how multiple tags compose — the
 * strictest wins per dimension) and the governed reclassification flow.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { withStepUp } from "../../../stepup/stepUp";
import type {
  ComplianceProfile,
  ComplianceProfileCarriedFloors,
  ProjectCompliance,
  WorkflowTemplate,
} from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, CodeBlock, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import {
  KV,
  optionEls,
  projectOpts,
  useAction,
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

  return (
    <>
      <PageHeader
        title="Compliance profiles"
        sub="One classification tag, cascaded into policy everywhere it applies."
        info={<p>A single classification tag on a project cascades required workflow stages, MCP data-scope defaults, audit-log retention, PII handling and infra floors — policy-as-code, one tag.</p>}
      />
      <div className={v.stack}>
        <Card flush title="Profiles">
          <Table<ComplianceProfile>
            columns={[
              { key: "tag", header: "Tag", sort: (p) => p.tag, render: (p) => <Badge tone="info">{p.tag}</Badge> },
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
            ]}
            rows={profiles.data?.profiles ?? []}
            rowKey={(p) => p.tag}
            loading={profiles.isLoading}
            error={profiles.error}
            onRetry={() => void profiles.refetch()}
            empty={
              <EmptyState
                title="No compliance profiles"
                body="Define the first framework below — its tag then becomes assignable to projects, teams and infra resources."
              />
            }
          />
        </Card>

        <UpsertProfileCard
          templates={templates.data?.templates ?? []}
          profiles={profiles.data?.profiles ?? []}
          profilesLoading={profiles.isLoading}
          profilesFailed={!!profiles.error}
        />
        <CascadePreviewCard />
        <ReclassifyCard />
      </div>
    </>
  );
}

/** the profile fields this form does not show: an update sends them back as they are, because the route replaces the
 * whole profile and an omitted floor would otherwise be cleared */
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
  profiles: ComplianceProfile[];
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
  const canSubmit = listReady && (!match || !!existing);
  const tplOpts = props.templates.filter((t) => !t.retiredAt);
  const activeIds = new Set(tplOpts.map((t) => t.id));
  const tplName = new Map(props.templates.map((t) => [t.id, t.name]));
  // retired (or unknown) templates the profile still requires stay required: they show disabled and the Select keeps them
  const keptIds = f.requiredTemplateIds.filter((id) => !activeIds.has(id));
  return (
    <Card title="Define or update a profile (upsert by tag)">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
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
            "Profile saved — re-posting the same tag updates it in place",
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
            <option value="read_write">read_write</option>
            <option value="read_only">read_only — write tools denied on attributed calls</option>
          </Select>
        </Field>
        <Field label="PII mode">
          <Select value={f.piiMode} onChange={(e) => set("piiMode", e.target.value)}>
            <option value="log">log — record category counts</option>
            <option value="warn">warn — proceed with warning</option>
            <option value="block">block — deny / withhold</option>
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
          {existing ? "Update profile" : "Save profile"}
        </Button>
        {props.profilesLoading && (
          <span className={v.hint} role="status">
            Loading the existing profiles, so a tag that already exists is updated rather than replaced.
          </span>
        )}
        {props.profilesFailed && (
          <span className={v.errLine} role="alert">
            The profiles list did not load, so saving is off: an existing tag would lose its floors. Retry the list above.
          </span>
        )}
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      {existing && (
        <p className={v.hint} role="status">
          Updating “{existing.tag}”: its budget, guardrail, red-team and isolation floors keep their current values.
          Typing an existing tag loads its stored values in place of anything entered before.
        </p>
      )}
      <p className={v.faint}>
        Posting an existing tag updates the profile in place — every classified project immediately
        inherits the new cascade. Retention floors compose longest-wins across profiles; patch cadence
        composes shortest-wins.
      </p>
    </Card>
  );
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
  const tagList = (profiles.data?.profiles ?? []).map((p) => p.tag);

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
