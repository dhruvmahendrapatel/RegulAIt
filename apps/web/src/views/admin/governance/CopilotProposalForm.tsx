/**
 * THE COPILOT PROPOSAL FORM (batch B9a).
 *
 * The copilot has exactly one route to a change: a proposal that opens an
 * ordinary Approvals-Queue item. Until this existed, that route had no UI at
 * all — the page listed proposals and applied approved ones, but the only way
 * to CREATE one was to POST a hand-written JSON diff. So the single most
 * governed write in the product was the one an admin could not reach without
 * curl, and the diff shapes the applier accepts were documented nowhere a user
 * could see them.
 *
 * FOUR THINGS THIS FORM IS BUILT TO MAKE STRUCTURALLY TRUE:
 *
 *  1. **It cannot compose a diff the applier would refuse.** Every kind's
 *     target is CHOSEN FROM THE REAL OBJECT, never typed: a grant from that
 *     user's or role's own entitlement list, a rule from that kind's rule
 *     table, a project from the project list. A uuid an admin retypes wrongly
 *     is the most likely cause of a refused proposal, and there is no text box
 *     here to retype one into.
 *  2. **A patch names only what moves.** Each editable field carries its own
 *     "change this" toggle, prefilled with the CURRENT value, because the
 *     target of both `applyRuleEdit` and `PATCH /v1/projects/:id` is a partial
 *     patch — and an admin who cannot see the current value cannot tell a
 *     tightening from a loosening.
 *  3. **The diff is shown before it is sent.** The exact JSON that will be
 *     recorded is rendered, because this object is what a named human will be
 *     asked to approve, and a proposer who cannot see it is asking someone
 *     else to consent to something they did not read either.
 *  4. **A refusal is rendered verbatim.** `POST /v1/copilot/proposals` now
 *     validates the diff before opening any approval, and its refusals name
 *     the enforcing schema (`createApprovalRuleSchema`,
 *     `updateProjectSchema`). Those sentences are the most useful thing on the
 *     screen when something is wrong, so they are shown as-is rather than
 *     flattened into "invalid input".
 *
 * WHAT IT DELIBERATELY DOES NOT DO: pre-check that the target still exists at
 * apply time, or pretend the proposal changes anything. It does not. Every
 * kind's copy says which public endpoint would perform the change, and that
 * the act would be attributed to the approving human.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Badge, Button, Card, CodeBlock, Field, Input, InfoButton, Select, Textarea } from "../../../ui/kit";
import {
  OutcomePanel,
  optionEls,
  useApiAction,
  useProjects,
  useRoles,
  useServers,
  useTeams,
  useUsers,
  userOpts,
  projectOpts,
  roleOpts,
  serverOpts,
  teamOpts,
} from "../adminKit";
import type {
  ApprovalRule,
  DataScopeRule,
  RateLimitRule,
  RoleGrants,
  UserAgentPolicyView,
} from "../../../api/adminTypes";
import a from "../admin.module.css";
import v from "../../views.module.css";

// ---------------------------------------------------------------------------
// The four kinds, each with the PUBLIC ENDPOINT that would apply it. The copy
// is not decoration: "which door does this go through" is the question an
// approver has to answer, and the applier really does refuse a kind with no
// such door rather than writing the change itself.
// ---------------------------------------------------------------------------

type Kind = "grant_revocation" | "policy_tightening" | "rule_to_approval" | "budget_adjustment";

const KINDS: Array<{ v: Kind; l: string; door: string; what: string }> = [
  {
    v: "grant_revocation",
    l: "Revoke a grant",
    door: "the same one-per-kind removal DELETE /v1/grants/… performs",
    what:
      "Removes one entitlement row. The next call the holder makes on that object is refused by " +
      "default-deny. Nothing already audited changes.",
  },
  {
    v: "policy_tightening",
    l: "Tighten a restriction rule",
    door: "applyRuleEdit — the single door for every rule-table write",
    what:
      "Edits one approval, rate-limit or data-scope rule. A versioned rule mints and activates a new " +
      "config version, so the edit enforces something rather than silently drifting.",
  },
  {
    v: "rule_to_approval",
    l: "Turn a noisy rule into an approval requirement",
    door: "the same create POST /v1/rules/approvals performs",
    what:
      "Creates an approval rule derived from a rate-limit or data-scope rule that denies often — so the " +
      "call becomes 'ask someone' instead of 'never'. The source rule is left in place.",
  },
  {
    v: "budget_adjustment",
    l: "Adjust a project budget",
    door: "the same merged write PATCH /v1/projects/:projectId performs",
    what:
      "Moves one project's budget fields, including that route's own budget-requires-approver " +
      "invariant. It cannot rename or re-parent a project — those are not budget fields.",
  },
];

const GRANT_KINDS = [
  { v: "agent", l: "Agent grant (per user)" },
  { v: "connector", l: "Connector grant (per user)" },
  { v: "tool", l: "MCP tool grant (per user)" },
  { v: "server", l: "MCP server read-all grant (per user)" },
  { v: "role_agent", l: "Agent grant (via role)" },
  { v: "role_connector", l: "Connector grant (via role)" },
  { v: "role_tool", l: "MCP tool grant (via role)" },
  { v: "role_server", l: "MCP server read-all grant (via role)" },
] as const;
type GrantKind = (typeof GRANT_KINDS)[number]["v"];

const RULE_KINDS = [
  { v: "approvals", l: "Approval rule" },
  { v: "rate-limits", l: "Rate limit" },
  { v: "data-scopes", l: "Data-scope rule" },
] as const;
type RuleKindPath = (typeof RULE_KINDS)[number]["v"];

const DEPLOY_MODES = [
  { v: "", l: "— unscoped (applies in every mode) —" },
  { v: "hosted", l: "hosted" },
  { v: "byoc", l: "byoc" },
  { v: "air_gapped", l: "air_gapped" },
];

type AnyRule = ApprovalRule | DataScopeRule | RateLimitRule;

/** one line that identifies a rule by WHO and WHERE it binds, not by its uuid.
 *  A select full of uuids is a select nobody can use correctly. */
function ruleLabel(kind: RuleKindPath, r: AnyRule, names: { user: Map<string, string>; role: Map<string, string>; team: Map<string, string>; server: Map<string, string> }): string {
  const subject =
    r.scope === "user"
      ? `user ${names.user.get(r.userId ?? "") ?? r.userId}`
      : r.scope === "role"
        ? `role ${names.role.get(r.roleId ?? "") ?? r.roleId}`
        : r.scope === "team"
          ? `team ${names.team.get(r.teamId ?? "") ?? r.teamId}`
          : "fleet";
  const where = r.serverScope === "all" ? "all servers" : `server ${names.server.get(r.serverId ?? "") ?? r.serverId}`;
  const tool = r.toolName ? `tool ${r.toolName}` : "every tool";
  const extra =
    kind === "rate-limits"
      ? ` · ${(r as RateLimitRule).maxCalls}/${(r as RateLimitRule).windowSeconds}s`
      : kind === "data-scopes"
        ? ` · ${(r as DataScopeRule).argPath} \u2208 {${(r as DataScopeRule).allowedValues.join(", ")}}`
        : "";
  return `${subject} · ${where} · ${tool}${extra}`;
}

/**
 * A field that is only in the patch when the admin says so.
 *
 * Both `applyRuleEdit` and the project PATCH take a PARTIAL patch, and the
 * difference between "leave this alone" and "set this to what it already is"
 * matters: the second mints a config version that changes nothing. So
 * inclusion is explicit, and the current value is shown either way.
 */
function PatchField(props: { label: string; current: ReactNode; on: boolean; onToggle: (on: boolean) => void; children: ReactNode }) {
  return (
    <div className={a.formRow}>
      <label style={{ display: "inline-flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
        <input type="checkbox" checked={props.on} onChange={(e) => props.onToggle(e.target.checked)} />
        <span>{props.label}</span>
      </label>
      {props.on ? (
        props.children
      ) : (
        <span className={v.faint}>
          unchanged — currently {props.current === null || props.current === "" ? "not set" : props.current}
        </span>
      )}
    </div>
  );
}

export function CopilotProposalForm(props: { queryId: string | null; question: string | null; onProposed: () => void }) {
  const act = useApiAction();
  const users = useUsers();
  const roles = useRoles();
  const teams = useTeams();
  const servers = useServers();
  const projects = useProjects();

  const [kind, setKind] = useState<Kind>("grant_revocation");
  const [title, setTitle] = useState("");
  const [rationale, setRationale] = useState("");
  const [approverUserId, setApproverUserId] = useState("");

  const names = useMemo(
    () => ({
      user: new Map((users.data?.users ?? []).map((u) => [u.id, u.displayName || u.email])),
      role: new Map((roles.data?.roles ?? []).map((r) => [r.id, r.name])),
      team: new Map((teams.data?.teams ?? []).map((t) => [t.id, t.name])),
      server: new Map((servers.data?.servers ?? []).map((s) => [s.id, s.name])),
    }),
    [users.data, roles.data, teams.data, servers.data],
  );

  // ---- grant_revocation state --------------------------------------------
  const [grantKind, setGrantKind] = useState<GrantKind>("agent");
  const [grantHolderId, setGrantHolderId] = useState("");
  const [grantRoleId, setGrantRoleId] = useState("");
  const [grantServerId, setGrantServerId] = useState("");
  const [grantId, setGrantId] = useState("");

  // ---- policy_tightening state -------------------------------------------
  const [ruleKind, setRuleKind] = useState<RuleKindPath>("approvals");
  const [ruleId, setRuleId] = useState("");
  const [patchOn, setPatchOn] = useState<Record<string, boolean>>({});
  const [patchVal, setPatchVal] = useState<Record<string, string>>({});

  // ---- rule_to_approval state --------------------------------------------
  const [sourceRuleKind, setSourceRuleKind] = useState<Exclude<RuleKindPath, "approvals">>("rate-limits");
  const [sourceRuleId, setSourceRuleId] = useState("");
  const [createToolName, setCreateToolName] = useState("");
  const [createWriteOnly, setCreateWriteOnly] = useState(false);
  const [createApprovalScope, setCreateApprovalScope] = useState("");
  const [createApproverUserId, setCreateApproverUserId] = useState("");

  // ---- budget_adjustment state -------------------------------------------
  const [projectId, setProjectId] = useState("");
  const [budgetOn, setBudgetOn] = useState<Record<string, boolean>>({});
  const [budgetVal, setBudgetVal] = useState<Record<string, string>>({});

  // ---- the lists a target is CHOSEN from, never typed ---------------------

  const isRoleGrant = grantKind.startsWith("role_");
  const needsServer = grantKind === "tool" || grantKind === "server";

  const userAgents = useQuery({
    queryKey: ["copilot-form", "user-agents", grantHolderId],
    queryFn: () => api.get<UserAgentPolicyView>(`/v1/users/${grantHolderId}/agents`),
    enabled: kind === "grant_revocation" && grantKind === "agent" && grantHolderId !== "",
  });
  const userConnectors = useQuery({
    queryKey: ["copilot-form", "user-connectors", grantHolderId],
    queryFn: () => api.get<{ connectors: Array<Record<string, unknown>> }>(`/v1/users/${grantHolderId}/connectors`),
    enabled: kind === "grant_revocation" && grantKind === "connector" && grantHolderId !== "",
  });
  const userMcp = useQuery({
    queryKey: ["copilot-form", "user-mcp", grantHolderId, grantServerId],
    queryFn: () =>
      api.get<{ entitlements: Array<{ kind: string; toolName: string | null; source: string; grantId: string }> }>(
        `/v1/users/${grantHolderId}/servers/${grantServerId}/entitlements`,
      ),
    enabled: kind === "grant_revocation" && needsServer && grantHolderId !== "" && grantServerId !== "",
  });
  const roleGrants = useQuery({
    queryKey: ["copilot-form", "role-grants", grantRoleId],
    queryFn: () => api.get<RoleGrants>(`/v1/roles/${grantRoleId}/grants`),
    enabled: kind === "grant_revocation" && isRoleGrant && grantRoleId !== "",
  });

  const tightenRules = useQuery({
    queryKey: ["copilot-form", "rules", ruleKind],
    queryFn: () => api.get<{ rules: AnyRule[] }>(`/v1/rules/${ruleKind}`),
    enabled: kind === "policy_tightening",
  });
  const sourceRules = useQuery({
    queryKey: ["copilot-form", "rules", sourceRuleKind],
    queryFn: () => api.get<{ rules: AnyRule[] }>(`/v1/rules/${sourceRuleKind}`),
    enabled: kind === "rule_to_approval",
  });

  /** the grants the chosen kind can actually name, each already carrying its
   *  real grant id. ROLE-SOURCED rows are excluded from the per-user kinds
   *  because they have no direct grant row to remove — that is the same fact
   *  the Agents page states on the row, and offering one here would compose a
   *  diff the applier must refuse. */
  const grantOptions = useMemo((): Array<{ v: string; l: string }> => {
    if (grantKind === "agent")
      return (userAgents.data?.agents ?? [])
        .filter((x) => x.source === "direct" && x.grantId)
        .map((x) => ({ v: x.grantId!, l: `${x.name} · ${x.provider} · tier ${x.tier}` }));
    if (grantKind === "connector")
      return (userConnectors.data?.connectors ?? [])
        .filter((c) => (c.source ?? "direct") === "direct" && typeof c.grantId === "string")
        .map((c) => ({
          v: String(c.grantId),
          l: `${String(c.name ?? c.connectorId)} · ${String(c.mode ?? "")}`.trim(),
        }));
    if (needsServer)
      return (userMcp.data?.entitlements ?? [])
        .filter((e) => e.source === "direct" && (grantKind === "tool" ? e.kind === "tool" : e.kind === "server-read-only"))
        .map((e) => ({ v: e.grantId, l: e.toolName ?? "server-wide read-all" }));
    const g = roleGrants.data;
    if (grantKind === "role_agent")
      return (g?.agents ?? []).map((x) => ({ v: x.grantId, l: x.agentName ?? x.agentId }));
    if (grantKind === "role_connector")
      return (g?.connectors ?? []).map((x) => ({ v: x.grantId, l: `${x.connectorName ?? x.connectorId} · ${x.mode}` }));
    if (grantKind === "role_tool")
      return (g?.tools ?? []).map((x) => ({ v: x.grantId, l: `${x.toolName} on ${x.serverName ?? x.serverId}` }));
    return (g?.servers ?? []).map((x) => ({ v: x.grantId, l: `${x.serverName ?? x.serverId} · read-all` }));
  }, [grantKind, needsServer, userAgents.data, userConnectors.data, userMcp.data, roleGrants.data]);

  const selectedRule = (tightenRules.data?.rules ?? []).find((r) => r.id === ruleId) ?? null;
  const selectedSource = (sourceRules.data?.rules ?? []).find((r) => r.id === sourceRuleId) ?? null;
  const selectedProject = (projects.data?.projects ?? []).find((p) => p.id === projectId) ?? null;

  // changing the target invalidates the patch: a value prefilled from one rule
  // and submitted against another is the quietest possible wrong answer
  useEffect(() => {
    setPatchOn({});
    setPatchVal({});
  }, [ruleId, ruleKind]);
  useEffect(() => {
    setGrantId("");
  }, [grantKind, grantHolderId, grantRoleId, grantServerId]);
  useEffect(() => {
    setBudgetOn({});
    setBudgetVal({});
  }, [projectId]);
  // the derivation: an approval requirement derived from a rule inherits that
  // rule's tool by default, because "this exact call should ask a human" is
  // what the evidence said
  useEffect(() => {
    setCreateToolName(selectedSource?.toolName ?? "");
  }, [sourceRuleId]);

  // ---- the diff, computed from the form and shown before it is sent -------

  const diff = useMemo((): Record<string, unknown> | null => {
    if (kind === "grant_revocation") return grantId ? { grantKind, grantId } : null;
    if (kind === "policy_tightening") {
      if (!ruleId) return null;
      const patch: Record<string, unknown> = {};
      for (const [f, on] of Object.entries(patchOn)) {
        if (!on) continue;
        const raw = patchVal[f] ?? "";
        if (f === "writeOnly") patch[f] = raw === "true";
        else if (f === "maxCalls" || f === "windowSeconds") patch[f] = raw === "" ? raw : Number(raw);
        else if (f === "allowedValues")
          patch[f] = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
        else if (f === "deployMode") patch[f] = raw === "" ? null : raw;
        else if (f === "toolName") patch[f] = raw === "" ? null : raw;
        else patch[f] = raw;
      }
      return Object.keys(patch).length ? { ruleKind, ruleId, patch } : null;
    }
    if (kind === "rule_to_approval") {
      if (!sourceRuleId || !selectedSource || !createApproverUserId) return null;
      // THE SCOPE IS INHERITED FROM THE SOURCE RULE, not re-entered. An
      // approval requirement "derived from" a rule that binds different
      // subjects is not derived from it, and re-typing these six fields is
      // where `createApprovalRuleSchema`'s superRefine would otherwise fire.
      const create: Record<string, unknown> = {
        scope: selectedSource.scope,
        serverScope: selectedSource.serverScope,
        approverUserId: createApproverUserId,
      };
      if (selectedSource.scope === "user") create.userId = selectedSource.userId;
      if (selectedSource.scope === "role") create.roleId = selectedSource.roleId;
      if (selectedSource.scope === "team") create.teamId = selectedSource.teamId;
      if (selectedSource.serverScope === "server") create.serverId = selectedSource.serverId;
      if (createToolName !== "") create.toolName = createToolName;
      if (createWriteOnly) create.writeOnly = true;
      if (createApprovalScope !== "") create.approvalScope = createApprovalScope;
      return { sourceRuleKind, sourceRuleId, create };
    }
    if (!projectId) return null;
    const patch: Record<string, unknown> = {};
    for (const [f, on] of Object.entries(budgetOn)) {
      if (!on) continue;
      const raw = budgetVal[f] ?? "";
      if (f === "budgetUsd") patch[f] = raw === "" ? null : Number(raw);
      else if (f === "alertThresholdPct") patch[f] = raw === "" ? raw : Number(raw);
      else if (f === "budgetApproverUserId") patch[f] = raw === "" ? null : raw;
      else patch[f] = raw;
    }
    return Object.keys(patch).length ? { projectId, patch } : null;
  }, [
    kind,
    grantKind,
    grantId,
    ruleKind,
    ruleId,
    patchOn,
    patchVal,
    sourceRuleKind,
    sourceRuleId,
    selectedSource,
    createToolName,
    createWriteOnly,
    createApprovalScope,
    createApproverUserId,
    projectId,
    budgetOn,
    budgetVal,
  ]);

  const chosen = KINDS.find((k) => k.v === kind)!;
  const ready = props.queryId !== null && diff !== null && title.trim() !== "" && rationale.trim() !== "" && approverUserId !== "";

  const submit = () =>
    void act
      .run(
        () =>
          api.post<{ proposal: { id: string }; approvalId: string; note: string }>("/v1/copilot/proposals", {
            queryId: props.queryId,
            kind,
            title: title.trim(),
            rationale: rationale.trim(),
            diff,
            approverUserId,
          }),
        "Proposal recorded and an Approvals-Queue item opened. Nothing was applied.",
      )
      .then((res) => {
        if (res) {
          setTitle("");
          setRationale("");
          setGrantId("");
          setPatchOn({});
          setBudgetOn({});
          props.onProposed();
        }
      });

  // ---- render -------------------------------------------------------------

  if (props.queryId === null)
    return (
      <Card title="Propose a change">
        <p className={v.faint}>
          A proposal must rest on a recorded query of <strong>your own</strong> — the gateway refuses one built on
          another user&rsquo;s evidence, because that evidence was retrieved under that user&rsquo;s entitlement scope
          and reusing it here would launder a wider read into your hands. Ask a question above, then propose from what
          it found.
        </p>
      </Card>
    );

  return (
    <Card title="Propose a change">
      <p className={v.faint}>
        This records a proposal and opens an ordinary Approvals-Queue item for a named human.{" "}
        <strong>Nothing is applied by proposing.</strong> If the diff is ever applied it runs through{" "}
        {chosen.door}, audited under the applying admin&rsquo;s identity — never the copilot&rsquo;s.
      </p>
      <p className={v.dim}>
        Grounded in your question: <em>{props.question}</em>
      </p>

      <Field label="What kind of change">
        <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {optionEls(KINDS.map((k) => ({ v: k.v, l: k.l })))}
        </Select>
      </Field>
      <p className={v.dim}>{chosen.what}</p>

      {/* ---------------- grant_revocation ---------------- */}
      {kind === "grant_revocation" && (
        <>
          <div className={a.formRow}>
            <Field label="Grant kind" grow>
              <Select value={grantKind} onChange={(e) => setGrantKind(e.target.value as GrantKind)}>
                {optionEls(GRANT_KINDS.map((g) => ({ v: g.v, l: g.l })))}
              </Select>
            </Field>
            {isRoleGrant ? (
              <Field label="Role" grow>
                <Select value={grantRoleId} onChange={(e) => setGrantRoleId(e.target.value)}>
                  {optionEls(roleOpts(roles.data?.roles), "— select —")}
                </Select>
              </Field>
            ) : (
              <Field label="Holder" grow>
                <Select value={grantHolderId} onChange={(e) => setGrantHolderId(e.target.value)}>
                  {optionEls(userOpts(users.data?.users), "— select —")}
                </Select>
              </Field>
            )}
            {needsServer && (
              <Field label="MCP server" grow>
                <Select value={grantServerId} onChange={(e) => setGrantServerId(e.target.value)}>
                  {optionEls(serverOpts(servers.data?.servers), "— select —")}
                </Select>
              </Field>
            )}
          </div>
          <Field label="Grant to revoke" grow>
            <Select value={grantId} onChange={(e) => setGrantId(e.target.value)}>
              {optionEls(grantOptions, "— select —")}
            </Select>
          </Field>
          {grantOptions.length === 0 && (
            <p className={v.faint}>
              No <strong>directly granted</strong> entitlement of that kind here. Role-conferred entitlements are
              excluded on purpose: they have no grant row of their own to remove, so the lever is the role — or a
              per-user revocation, which subtracts without touching the role.
            </p>
          )}
        </>
      )}

      {/* ---------------- policy_tightening ---------------- */}
      {kind === "policy_tightening" && (
        <>
          <div className={a.formRow}>
            <Field label="Rule kind" grow>
              <Select value={ruleKind} onChange={(e) => setRuleKind(e.target.value as RuleKindPath)}>
                {optionEls(RULE_KINDS.map((r) => ({ v: r.v, l: r.l })))}
              </Select>
            </Field>
            <Field label="Rule" grow>
              <Select value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
                {optionEls(
                  (tightenRules.data?.rules ?? []).map((r) => ({ v: r.id, l: ruleLabel(ruleKind, r, names) })),
                  "— select —",
                )}
              </Select>
            </Field>
          </div>
          {selectedRule && (
            <>
              <p className={v.faint}>
                Name only what should move. A field left unchanged is absent from the patch, which is not the same as
                setting it to the value it already has — the second mints a config version that changes nothing.
              </p>
              <PatchField
                label="tool"
                current={selectedRule.toolName ?? ""}
                on={patchOn.toolName ?? false}
                onToggle={(on) => setPatchOn((p) => ({ ...p, toolName: on }))}
              >
                <Field label="Tool name (empty = every tool)" grow>
                  <Input
                    value={patchVal.toolName ?? selectedRule.toolName ?? ""}
                    onChange={(e) => setPatchVal((p) => ({ ...p, toolName: e.target.value }))}
                  />
                </Field>
              </PatchField>
              {ruleKind === "approvals" && (
                <>
                  <PatchField
                    label="write-only"
                    current={String((selectedRule as ApprovalRule & { writeOnly?: boolean }).writeOnly ?? false)}
                    on={patchOn.writeOnly ?? false}
                    onToggle={(on) => setPatchOn((p) => ({ ...p, writeOnly: on }))}
                  >
                    <Field label="Applies to write tools only" grow>
                      <Select
                        value={patchVal.writeOnly ?? "true"}
                        onChange={(e) => setPatchVal((p) => ({ ...p, writeOnly: e.target.value }))}
                      >
                        {optionEls([
                          { v: "true", l: "write tools only" },
                          { v: "false", l: "every tool the rule matches" },
                        ])}
                      </Select>
                    </Field>
                  </PatchField>
                  <PatchField
                    label="approver"
                    current={names.user.get((selectedRule as ApprovalRule).approverUserId) ?? ""}
                    on={patchOn.approverUserId ?? false}
                    onToggle={(on) => setPatchOn((p) => ({ ...p, approverUserId: on }))}
                  >
                    <Field label="Who approves calls this rule catches" grow>
                      <Select
                        value={patchVal.approverUserId ?? ""}
                        onChange={(e) => setPatchVal((p) => ({ ...p, approverUserId: e.target.value }))}
                      >
                        {optionEls(userOpts(users.data?.users), "— select —")}
                      </Select>
                    </Field>
                  </PatchField>
                </>
              )}
              {ruleKind === "rate-limits" && (
                <>
                  <PatchField
                    label="max calls"
                    current={String((selectedRule as RateLimitRule).maxCalls)}
                    on={patchOn.maxCalls ?? false}
                    onToggle={(on) => setPatchOn((p) => ({ ...p, maxCalls: on }))}
                  >
                    <Field label="Calls allowed in the window" grow>
                      <Input
                        type="number"
                        min={0}
                        value={patchVal.maxCalls ?? String((selectedRule as RateLimitRule).maxCalls)}
                        onChange={(e) => setPatchVal((p) => ({ ...p, maxCalls: e.target.value }))}
                      />
                    </Field>
                  </PatchField>
                  <PatchField
                    label="window"
                    current={`${(selectedRule as RateLimitRule).windowSeconds}s`}
                    on={patchOn.windowSeconds ?? false}
                    onToggle={(on) => setPatchOn((p) => ({ ...p, windowSeconds: on }))}
                  >
                    <Field label="Window, in seconds" grow>
                      <Input
                        type="number"
                        min={1}
                        value={patchVal.windowSeconds ?? String((selectedRule as RateLimitRule).windowSeconds)}
                        onChange={(e) => setPatchVal((p) => ({ ...p, windowSeconds: e.target.value }))}
                      />
                    </Field>
                  </PatchField>
                </>
              )}
              {ruleKind === "data-scopes" && (
                <>
                  <PatchField
                    label="argument path"
                    current={(selectedRule as DataScopeRule).argPath}
                    on={patchOn.argPath ?? false}
                    onToggle={(on) => setPatchOn((p) => ({ ...p, argPath: on }))}
                  >
                    <Field label="Argument the rule constrains" grow>
                      <Input
                        value={patchVal.argPath ?? (selectedRule as DataScopeRule).argPath}
                        onChange={(e) => setPatchVal((p) => ({ ...p, argPath: e.target.value }))}
                      />
                    </Field>
                  </PatchField>
                  <PatchField
                    label="allowed values"
                    current={(selectedRule as DataScopeRule).allowedValues.join(", ")}
                    on={patchOn.allowedValues ?? false}
                    onToggle={(on) => setPatchOn((p) => ({ ...p, allowedValues: on }))}
                  >
                    <Field label="Allowed values, comma-separated" grow>
                      <Input
                        value={patchVal.allowedValues ?? (selectedRule as DataScopeRule).allowedValues.join(", ")}
                        onChange={(e) => setPatchVal((p) => ({ ...p, allowedValues: e.target.value }))}
                      />
                    </Field>
                  </PatchField>
                </>
              )}
              <PatchField
                label="deploy mode"
                current={selectedRule.deployMode ?? ""}
                on={patchOn.deployMode ?? false}
                onToggle={(on) => setPatchOn((p) => ({ ...p, deployMode: on }))}
              >
                <Field label="Deployment mode this rule is scoped to" grow>
                  <Select
                    value={patchVal.deployMode ?? selectedRule.deployMode ?? ""}
                    onChange={(e) => setPatchVal((p) => ({ ...p, deployMode: e.target.value }))}
                  >
                    {optionEls(DEPLOY_MODES)}
                  </Select>
                </Field>
              </PatchField>
            </>
          )}
        </>
      )}

      {/* ---------------- rule_to_approval ---------------- */}
      {kind === "rule_to_approval" && (
        <>
          <div className={a.formRow}>
            <Field label="Derive from" grow>
              <Select
                value={sourceRuleKind}
                onChange={(e) => setSourceRuleKind(e.target.value as Exclude<RuleKindPath, "approvals">)}
              >
                {optionEls([
                  { v: "rate-limits", l: "a rate limit that denies often" },
                  { v: "data-scopes", l: "a data-scope rule that denies often" },
                ])}
              </Select>
            </Field>
            <Field label="Source rule" grow>
              <Select value={sourceRuleId} onChange={(e) => setSourceRuleId(e.target.value)}>
                {optionEls(
                  (sourceRules.data?.rules ?? []).map((r) => ({ v: r.id, l: ruleLabel(sourceRuleKind, r, names) })),
                  "— select —",
                )}
              </Select>
            </Field>
          </div>
          {selectedSource && (
            <p className={v.faint}>
              The new approval rule <strong>inherits the source rule&rsquo;s scope</strong> — subject, server and
              deploy binding — because a requirement &ldquo;derived from&rdquo; a rule that binds different subjects is
              not derived from it. Only the fields below are yours to set. The source rule is left in place; approval
              and refusal are different answers, and removing the refusal is a separate decision.
            </p>
          )}
          <div className={a.formRow}>
            <Field label="Tool (empty = every tool the scope matches)" grow>
              <Input value={createToolName} onChange={(e) => setCreateToolName(e.target.value)} />
            </Field>
            <Field label="Approver for the new rule" grow>
              <Select value={createApproverUserId} onChange={(e) => setCreateApproverUserId(e.target.value)}>
                {optionEls(userOpts(users.data?.users), "— select —")}
              </Select>
            </Field>
          </div>
          <div className={a.formRow}>
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={createWriteOnly} onChange={(e) => setCreateWriteOnly(e.target.checked)} />
              <span>write tools only</span>
            </label>
            <Field label="What a consent is bound to" grow>
              <Select value={createApprovalScope} onChange={(e) => setCreateApprovalScope(e.target.value)}>
                {optionEls([
                  { v: "", l: "— the strict default: the exact arguments approved —" },
                  { v: "action", l: "action — the exact arguments the approver signed for" },
                  { v: "tool", l: "tool — any call of this tool (the looser reading)" },
                ])}
              </Select>
            </Field>
            <InfoButton label="what a consent is bound to">
              <p>
                Absent is the strict reading and the default: a consent covers the exact arguments the approver saw.
                <strong> tool</strong> is the deliberate escape hatch — one approval then covers any later call of that
                tool — so it is never what you get by saying nothing.
              </p>
            </InfoButton>
          </div>
        </>
      )}

      {/* ---------------- budget_adjustment ---------------- */}
      {kind === "budget_adjustment" && (
        <>
          <Field label="Project" grow>
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {optionEls(projectOpts(projects.data?.projects), "— select —")}
            </Select>
          </Field>
          {selectedProject && (
            <>
              <p className={v.dim}>
                Spent so far: <strong>${selectedProject.spentUsd.toFixed(2)}</strong> against a budget of{" "}
                <strong>{selectedProject.budgetUsd === null ? "none" : `$${selectedProject.budgetUsd}`}</strong>.
              </p>
              <PatchField
                label="budget"
                current={selectedProject.budgetUsd === null ? "" : `$${selectedProject.budgetUsd}`}
                on={budgetOn.budgetUsd ?? false}
                onToggle={(on) => setBudgetOn((p) => ({ ...p, budgetUsd: on }))}
              >
                <Field label="Budget in USD (empty removes the budget)" grow>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={budgetVal.budgetUsd ?? String(selectedProject.budgetUsd ?? "")}
                    onChange={(e) => setBudgetVal((p) => ({ ...p, budgetUsd: e.target.value }))}
                  />
                </Field>
              </PatchField>
              <PatchField
                label="budget approver"
                current={names.user.get(selectedProject.budgetApproverUserId ?? "") ?? ""}
                on={budgetOn.budgetApproverUserId ?? false}
                onToggle={(on) => setBudgetOn((p) => ({ ...p, budgetApproverUserId: on }))}
              >
                <Field label="Who approves spend past the budget" grow>
                  <Select
                    value={budgetVal.budgetApproverUserId ?? selectedProject.budgetApproverUserId ?? ""}
                    onChange={(e) => setBudgetVal((p) => ({ ...p, budgetApproverUserId: e.target.value }))}
                  >
                    {optionEls(userOpts(users.data?.users), "— none —")}
                  </Select>
                </Field>
                <InfoButton label="why a budget needs an approver">
                  <p>
                    A budget with nobody to ask is a wall, not a control: the project PATCH refuses a budget without an
                    approver, and this form surfaces that refusal rather than working around it.
                  </p>
                </InfoButton>
              </PatchField>
              <PatchField
                label="period"
                current={selectedProject.budgetPeriod ?? ""}
                on={budgetOn.budgetPeriod ?? false}
                onToggle={(on) => setBudgetOn((p) => ({ ...p, budgetPeriod: on }))}
              >
                <Field label="Budget period" grow>
                  <Select
                    value={budgetVal.budgetPeriod ?? selectedProject.budgetPeriod ?? "none"}
                    onChange={(e) => setBudgetVal((p) => ({ ...p, budgetPeriod: e.target.value }))}
                  >
                    {optionEls([
                      { v: "none", l: "none — a single running total" },
                      { v: "monthly", l: "monthly — resets each month" },
                    ])}
                  </Select>
                </Field>
              </PatchField>
              <PatchField
                label="alert threshold"
                current={selectedProject.alertThresholdPct === null ? "" : `${selectedProject.alertThresholdPct}%`}
                on={budgetOn.alertThresholdPct ?? false}
                onToggle={(on) => setBudgetOn((p) => ({ ...p, alertThresholdPct: on }))}
              >
                <Field label="Alert at this percent of budget (1–100)" grow>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={budgetVal.alertThresholdPct ?? String(selectedProject.alertThresholdPct ?? 80)}
                    onChange={(e) => setBudgetVal((p) => ({ ...p, alertThresholdPct: e.target.value }))}
                  />
                </Field>
              </PatchField>
            </>
          )}
        </>
      )}

      {/* ---------------- what a human will read ---------------- */}
      <div className={a.formRow}>
        <Field label="Title — what the approver sees first" grow>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            placeholder="Revoke the three write-tool grants unused for 90 days"
          />
        </Field>
        <Field label="Approver" grow>
          <Select value={approverUserId} onChange={(e) => setApproverUserId(e.target.value)}>
            {optionEls(userOpts(users.data?.users), "— select —")}
          </Select>
        </Field>
      </div>
      <Field label="Rationale — the evidence, in your own words" grow>
        <Textarea
          rows={3}
          maxLength={4000}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Zero invocations in the queried window; the grants were issued for a migration that finished in June."
        />
      </Field>

      {/* THE DIFF, BEFORE IT IS SENT. This object is what a named human will be
          asked to approve; a proposer who has not seen it is asking someone
          else to consent to something they did not read either. */}
      <p className={v.faint}>The exact diff that will be recorded:</p>
      {diff ? (
        <CodeBlock maxHeight="14rem">{JSON.stringify(diff, null, 2)}</CodeBlock>
      ) : (
        <p className={v.dim}>
          <Badge tone="warn">incomplete</Badge> Choose a target
          {kind === "policy_tightening" || kind === "budget_adjustment" ? " and at least one field to change" : ""} — a
          proposal with nothing in its diff is refused rather than recorded, because an approval on the record against
          a change that does nothing is worse than no proposal at all.
        </p>
      )}

      <div className={v.row}>
        <Button variant="primary" disabled={!ready || act.busy} onClick={submit}>
          Record proposal and open an approval
        </Button>
        {!ready && (
          <span className={v.faint}>
            Needs a target, a title, a rationale and an approver — all four are what the queue item carries.
          </span>
        )}
      </div>
      <OutcomePanel outcome={act.outcome} testId="copilot-proposal-outcome" />
    </Card>
  );
}
