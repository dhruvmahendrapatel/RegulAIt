/**
 * Workflow templates (pillar 2 admin) — stage-chain templates with starter
 * definitions, retire-with-reason (soft disable), and the six-dimension
 * assignment rules that route changes onto them.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type {
  AssignmentRule,
  GitConnection,
  TemplateGalleryEntry,
  TemplateGalleryProfile,
  WorkflowTemplate,
} from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Textarea,
} from "../../../ui/kit";
import { ReasonModal, optionEls, useAction, useComplianceProfiles, useUsers, userOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

const conds = (x: AssignmentRule) =>
  [
    x.pathPattern ? `path ${x.pathPattern}` : null,
    x.changeType ? `type ${x.changeType}` : null,
    x.environment ? `env ${x.environment}` : null,
    x.targetSystem ? `target ${x.targetSystem}` : null,
    x.initiatorRole ? `role ${x.initiatorRole}` : null,
    x.dataSensitivity ? `sensitivity ${x.dataSensitivity}` : null,
  ]
    .filter(Boolean)
    .join(" + ");

export default function WorkflowTemplatesPage() {
  const act = useAction();
  const templates = useQuery({
    queryKey: ["admin", "wf-templates"],
    queryFn: () => api.get<{ templates: WorkflowTemplate[] }>("/v1/workflows/templates"),
  });
  const rules = useQuery({
    queryKey: ["admin", "wf-rules"],
    queryFn: () => api.get<{ rules: AssignmentRule[] }>("/v1/workflows/assignment-rules"),
  });
  const git = useQuery({
    queryKey: ["admin", "git-connections"],
    queryFn: () => api.get<{ connections: GitConnection[] }>("/v1/git/connections"),
  });
  const profiles = useComplianceProfiles();

  const [retire, setRetire] = useState<WorkflowTemplate | null>(null);
  const tplName = useMemo(
    () => new Map((templates.data?.templates ?? []).map((t) => [t.id, t.name])),
    [templates.data],
  );

  return (
    <>
      <PageHeader
        title="Workflow templates"
        sub="Stage chains, and how changes route to them."
        info={<p>Stage chains and how changes route to them. Retired templates start no new instances; in-flight ones keep their snapshotted definition.</p>}
      />
      <div className={v.stack}>
        <Card title="Templates">
          {templates.isLoading && <span className={v.dim}>Loading…</span>}
          {(templates.data?.templates ?? []).length === 0 && !templates.isLoading && (
            <EmptyState title="No templates yet" body="Author one below — start from a starter definition." />
          )}
          {(templates.data?.templates ?? []).map((tpl) => {
            const assigned = (rules.data?.rules ?? []).filter((x) => x.templateId === tpl.id);
            return (
              <div key={tpl.id} className={v.listRow}>
                <div className={v.grow}>
                  <div className={v.row}>
                    <strong className={tpl.retiredAt ? v.faint : undefined}>{tpl.name}</strong>
                    {tpl.retiredAt && (
                      <Badge
                        tone="danger"
                        title={`retired ${String(tpl.retiredAt).slice(0, 10)}${tpl.retiredReason ? ` — ${tpl.retiredReason}` : ""}`}
                      >
                        retired
                      </Badge>
                    )}
                    {tpl.definition.costSensitivity && <Badge>{tpl.definition.costSensitivity}</Badge>}
                  </div>
                  <div className={a.stageRail}>
                    {(tpl.definition.stages ?? []).map((s, i) => (
                      <span key={`${s.id}-${i}`} className={a.stage}>
                        {s.id}
                        <span className={a.stageType}>{s.type}</span>
                      </span>
                    ))}
                  </div>
                  <div className={v.faint} style={{ marginTop: "var(--s0)" }}>
                    {tpl.retiredAt
                      ? `retired — starts no new instances${tpl.retiredReason ? `. Why: ${tpl.retiredReason}` : ""}`
                      : assigned.length
                        ? `routed when: ${assigned.map(conds).join("  |  ")}`
                        : "no assignment rule routes here — reachable only via compliance cascade or an admin's explicit pick"}
                  </div>
                </div>
                {!tpl.retiredAt && (
                  <Button
                    size="sm"
                    onClick={() => setRetire(tpl)}
                    title="soft-disable: no new instances; in-flight unaffected"
                  >
                    retire
                  </Button>
                )}
              </div>
            );
          })}
        </Card>

        <GalleryCard />

        <AuthorCard connections={git.data?.connections ?? []} />

        <Card title="Assignment rules — which template governs which change">
          <RuleForm
            templates={(templates.data?.templates ?? []).filter((t) => !t.retiredAt)}
            sensitivities={(profiles.data?.profiles ?? []).map((p) => p.tag)}
          />
          <Table<AssignmentRule>
            columns={[
              {
                key: "template",
                header: "Template",
                render: (r) => tplName.get(r.templateId) ?? r.templateId,
              },
              { key: "matches", header: "Matches when", render: (r) => conds(r) || "—" },
              { key: "created", header: "Created", render: (r) => ago(r.createdAt) },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (r) => <DeleteRuleButton rule={r} />,
              },
            ]}
            rows={rules.data?.rules ?? []}
            rowKey={(r) => r.id}
            loading={rules.isLoading}
            error={rules.error}
            onRetry={() => void rules.refetch()}
            empty={<EmptyState title="No assignment rules" />}
          />
          <p className={v.faint}>
            Conditions AND together; set at least one. All six dims are wired: path, change type,
            environment, target system, initiator role (matched against the initiator's SERVER-derived
            roles), and data sensitivity (the compliance classifications of the change's attributed
            project). Every rule that matches a change contributes its template — the merged flow keeps
            every sign-off.
          </p>
        </Card>
      </div>
      <ReasonModal
        open={retire !== null}
        title={`Retire template “${retire?.name}”?`}
        body={
          <span className={v.dim}>
            Soft-disable: no new instances start from it; in-flight instances keep their snapshotted
            definition. The reason is the retirement record.
          </span>
        }
        confirmLabel="Retire"
        danger
        placeholder="why is this template retiring? (required, recorded)"
        onCancel={() => setRetire(null)}
        onConfirm={(reason) => {
          const t = retire;
          setRetire(null);
          if (t)
            void act.run(
              () => api.post(`/v1/workflows/templates/${t.id}/retire`, { reason }),
              "Template retired — no new instances; in-flight ones are unaffected",
            );
        }}
      />
    </>
  );
}

function DeleteRuleButton(props: { rule: AssignmentRule }) {
  const act = useAction();
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
        delete
      </Button>
      <ConfirmModal
        open={confirm}
        title="Delete this assignment rule?"
        body="Routing stops; in-flight instances keep their snapshotted definition."
        danger
        confirmLabel="Delete rule"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void act.run(
            () => api.del(`/v1/workflows/assignment-rules/${props.rule.id}`),
            "Rule deleted — routing stops; in-flight instances keep their snapshotted definition",
          );
        }}
      />
    </>
  );
}

// ---- the template gallery (ADR-0077) --------------------------------------

/**
 * Cascade-aware starting shapes. The stage annotations and the
 * compliance-heavy shapes come DERIVED from the live compliance profiles'
 * required templates (never a stored list) — editing a profile moves this
 * gallery on the next load. "Create" instantiates through the one
 * template-creation path, so full validation applies.
 */
function GalleryCard() {
  const act = useAction();
  const users = useUsers();
  const gallery = useQuery({
    queryKey: ["admin", "wf-template-gallery"],
    queryFn: () =>
      api.get<{ entries: TemplateGalleryEntry[]; profiles: TemplateGalleryProfile[] }>(
        "/v1/workflows/template-gallery",
      ),
  });
  const [approverUserId, setApproverUserId] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});

  const profiles = gallery.data?.profiles ?? [];
  return (
    <Card title="Template gallery — cascade-aware starting shapes">
      {gallery.isLoading && <span className={v.dim}>Loading…</span>}
      {!gallery.isLoading && (
        <>
          <div className={a.formRow} style={{ marginBottom: "var(--s2)" }}>
            <Field label="Approver for sign-off stages (optional)">
              <Select value={approverUserId} onChange={(e) => setApproverUserId(e.target.value)}>
                {optionEls(userOpts(users.data?.users), "— the requesting user —")}
              </Select>
            </Field>
          </div>
          {(gallery.data?.entries ?? []).map((entry) => {
            const demanded = entry.stageAnnotations.filter((x) => x.demandedByTags.length > 0);
            return (
              <div key={entry.galleryId} className={v.listRow}>
                <div className={v.grow}>
                  <div className={v.row}>
                    <strong>{entry.title}</strong>
                    {entry.source === "compliance_profile" && (
                      <Badge tone="info" title="shape derived from a compliance profile's required templates">
                        {entry.profileTag}
                      </Badge>
                    )}
                  </div>
                  <div className={a.stageRail}>
                    {(entry.definition.stages ?? []).map((s, i) => {
                      const tags =
                        entry.stageAnnotations.find((x) => x.stageId === s.id)?.demandedByTags ?? [];
                      return (
                        <span
                          key={`${s.id}-${i}`}
                          className={a.stage}
                          title={tags.length ? `demanded by compliance profile(s): ${tags.join(", ")}` : undefined}
                        >
                          {s.id}
                          <span className={a.stageType}>{s.type}</span>
                          {tags.map((t) => (
                            <Badge key={t} tone="warn" title={`the '${t}' cascade forces this stage`}>
                              {t}
                            </Badge>
                          ))}
                        </span>
                      );
                    })}
                  </div>
                  <div className={v.faint} style={{ marginTop: "var(--s0)" }}>
                    {entry.description}
                    {demanded.length > 0 &&
                      ` Cascade: ${demanded
                        .map((x) => `${x.stageId} ← ${x.demandedByTags.join("+")}`)
                        .join(" · ")}.`}
                  </div>
                </div>
                <div className={v.row}>
                  <Input
                    aria-label={`Template name for ${entry.title}`}
                    placeholder="new template name"
                    value={names[entry.galleryId] ?? ""}
                    onChange={(e) => setNames((s) => ({ ...s, [entry.galleryId]: e.target.value }))}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={act.busy || !(names[entry.galleryId] ?? "").trim()}
                    onClick={() =>
                      void act.run(
                        () =>
                          api.post(`/v1/workflows/template-gallery/${entry.galleryId}/create`, {
                            name: (names[entry.galleryId] ?? "").trim(),
                            ...(approverUserId ? { approverUserId } : {}),
                          }),
                        "Template created from the gallery — validated like any authored template",
                      )
                    }
                  >
                    Create
                  </Button>
                </div>
              </div>
            );
          })}
          <p className={v.faint}>
            Stage badges and the compliance-heavy shapes are derived live from the compliance
            profiles’ required templates — the same §8.3 rules the workflow engine enforces —
            so this gallery can never drift from the cascade.
            {profiles.length > 0 &&
              ` Profiles: ${profiles
                .map(
                  (p) =>
                    `${p.tag} (pii ${p.piiMode}, mcp ${p.mcpDefaultMode}${
                      p.auditRetentionDays ? `, audit ${p.auditRetentionDays}d` : ""
                    })`,
                )
                .join(" · ")}.`}
          </p>
          {act.error && (
            <span className={v.errLine} role="alert">
              {act.error}
            </span>
          )}
        </>
      )}
    </Card>
  );
}

// ---- author a template ----------------------------------------------------

function AuthorCard(props: { connections: GitConnection[] }) {
  const act = useAction();
  const connName = props.connections[0]?.name ?? "demo-git";
  const starters = useMemo(() => {
    const planStages = [
      { id: "intake", type: "trigger" },
      { id: "plan", type: "planning" },
      { id: "requirements", type: "artifact_generation", output: "requirements_file" },
      { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
    ];
    const buildStages = [
      ...planStages,
      { id: "build", type: "automated_build", scope: "requirements_file" },
      { id: "checks", type: "automated_check", checks: ["unit_tests", "lint"] },
    ];
    return [
      { id: "plan", label: "Plan & sign-off (4 stages)", def: { workflow: "plan-signoff", stages: planStages } },
      { id: "build", label: "Plan, build & check (6 stages)", def: { workflow: "build-check", stages: buildStages } },
      {
        id: "pipeline",
        label: "Complete pipeline to merge (10 stages)",
        def: {
          workflow: "complete-pipeline",
          stages: [
            ...buildStages.slice(0, 5),
            { id: "checks", type: "automated_check", checks: ["unit_tests", "lint", "security_scan"] },
            { id: "branch", type: "git_operation", action: "create_branch", connection: connName, repo: "acme/app" },
            { id: "open_pr", type: "git_operation", action: "open_pr", connection: connName, repo: "acme/app" },
            { id: "merge_gate", type: "human_approval", approvers: ["requesting_user"] },
            { id: "merge", type: "git_operation", action: "merge", connection: connName, repo: "acme/app", strategy: "squash" },
          ],
        },
      },
    ];
  }, [connName]);

  const [name, setName] = useState("");
  const [starter, setStarter] = useState("plan");
  const [json, setJson] = useState("");

  useEffect(() => {
    const s = starters.find((x) => x.id === starter) ?? starters[0]!;
    setJson(JSON.stringify(s.def, null, 2));
  }, [starter, starters]);

  return (
    <Card title="Author a template">
      <form
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            let definition: unknown;
            try {
              definition = JSON.parse(json);
            } catch (ex) {
              throw new Error(`definition JSON does not parse — ${(ex as Error).message}`);
            }
            await api.post("/v1/workflows/templates", { name, definition });
          }, "Template created");
        }}
      >
        <div className={a.formRow}>
          <Field label="Name">
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. api-change" />
          </Field>
          <Field label="Start from">
            <Select value={starter} onChange={(e) => setStarter(e.target.value)}>
              {starters.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Definition (JSON)">
          <Textarea
            rows={14}
            spellCheck={false}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}
          />
        </Field>
        <p className={v.faint}>
          A definition is {"{ workflow, costSensitivity?, stages[] }"}; the first stage must be a trigger.
          Stage types: trigger · planning · artifact_generation {"{output}"} · human_approval{" "}
          {"{approvers}"} · automated_build {"{scope?, run?}"} · automated_check {"{checks[], offlineAutoPass?}"} ·
          git_operation {"{action: create_branch | open_pr | merge, connection, repo, …}"}. open_pr needs an
          earlier create_branch, merge an earlier open_pr. A named check nobody reports stays pending and holds
          the stage; offlineAutoPass: true passes it instead, labelled “auto-passed — no report (offline
          mode)” everywhere — but only on a gateway started with REGULAIT_OFFLINE_CHECKS=1, and never on a
          deployed box. Validation errors from the server appear below,
          field by field.
        </p>
        <div className={v.row}>
          <Button type="submit" variant="primary" disabled={act.busy}>
            Create template
          </Button>
          {act.error && (
            <span className={v.errLine} role="alert">
              {act.error}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

// ---- assignment rule form -------------------------------------------------

function RuleForm(props: { templates: WorkflowTemplate[]; sensitivities: string[] }) {
  const act = useAction();
  const [templateId, setTemplateId] = useState("");
  const [f, setF] = useState({
    pathPattern: "",
    changeType: "",
    environment: "",
    targetSystem: "",
    initiatorRole: "",
    dataSensitivity: "",
  });
  const set = (k: keyof typeof f, val: string) => setF((s) => ({ ...s, [k]: val }));
  return (
    <form
      className={a.formRow}
      style={{ marginBottom: "var(--s2)" }}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(
          () =>
            api.post("/v1/workflows/assignment-rules", {
              templateId,
              ...Object.fromEntries(Object.entries(f).filter(([, val]) => val !== "")),
            }),
          "Assignment rule added",
        );
      }}
    >
      <Field label="Template">
        <Select required value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {optionEls(
            props.templates.map((t) => ({ v: t.id, l: t.name })),
            "— select —",
          )}
        </Select>
      </Field>
      <Field label="Path pattern">
        <Input value={f.pathPattern} onChange={(e) => set("pathPattern", e.target.value)} placeholder="e.g. src/**" />
      </Field>
      <Field label="Change type">
        <Input value={f.changeType} onChange={(e) => set("changeType", e.target.value)} placeholder="e.g. feature" />
      </Field>
      <Field label="Environment">
        <Input value={f.environment} onChange={(e) => set("environment", e.target.value)} placeholder="e.g. production" />
      </Field>
      <Field label="Target system">
        <Input value={f.targetSystem} onChange={(e) => set("targetSystem", e.target.value)} placeholder="e.g. checkout-svc" />
      </Field>
      <Field label="Initiator role">
        <Input value={f.initiatorRole} onChange={(e) => set("initiatorRole", e.target.value)} placeholder="e.g. release-manager" />
      </Field>
      <Field label="Data sensitivity">
        <Select value={f.dataSensitivity} onChange={(e) => set("dataSensitivity", e.target.value)}>
          {optionEls(
            props.sensitivities.map((t) => ({ v: t, l: t })),
            "— any sensitivity —",
          )}
        </Select>
      </Field>
      <Button type="submit" size="sm" disabled={act.busy}>
        Add rule
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </form>
  );
}
