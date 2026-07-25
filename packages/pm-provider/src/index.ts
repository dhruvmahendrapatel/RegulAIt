/**
 * @regulait/pm-provider — pillar 8's provider abstraction (EPIC-06,
 * PM_TOOL_INTEGRATION_SPEC §2/§3/§6).
 *
 * Follows the git-provider playbook: a neutral interface, one real adapter
 * (Azure DevOps, REST with injectable fetch), an in-memory mock for tests and
 * air-gapped development, and a registry that explicitly rejects adapters
 * that are interface-ready but not implemented — no silent promises.
 *
 * The load-bearing part (per §1/§7) is the FIELD MAPPING layer: every adapter
 * ships a default mapping an admin can override, and the resolver that turns
 * RegulAIt concepts into provider-native field payloads is pure and
 * zod-validated. Source of truth (§3): priority, description, and acceptance
 * criteria belong to the PM tool — this package never caches them; reads go
 * through getWorkItem live.
 *
 * Status ownership (documented decision — the spec leaves it open): RegulAIt
 * owns node/stage status because it owns the state machines; status flows
 * OUTBOUND through the mapping's statusMap. An unmapped status is skipped,
 * never invented.
 */

import { z } from "zod";

export const PM_PROVIDER_KINDS = [
  "azure_devops",
  "jira",
  "linear",
  "asana",
  "monday",
  "generic_webhook",
  "mock",
] as const;
export type PmProviderKind = (typeof PM_PROVIDER_KINDS)[number];

export class PmProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface WorkItemRef {
  /** provider-native work-item identifier, stringified */
  id: string;
  url: string;
}

export interface WorkItem extends WorkItemRef {
  type: string;
  state: string | null;
  /** provider-native field paths → values, fetched live (never cached here) */
  fields: Record<string, unknown>;
  comments: string[];
}

export interface PmProvider {
  readonly kind: PmProviderKind;
  createWorkItem(
    project: string,
    type: string,
    fields: Record<string, unknown>,
  ): Promise<WorkItemRef>;
  updateFields(project: string, id: string, fields: Record<string, unknown>): Promise<void>;
  transitionState(project: string, id: string, state: string): Promise<void>;
  addComment(project: string, id: string, text: string): Promise<void>;
  getWorkItem(project: string, id: string): Promise<WorkItem>;
}

// ---------------------------------------------------------------------------
// Field mapping (§6) — zod-validated JSON (repo convention), with per-adapter
// defaults (§7: defaults ship with the adapter, admins override, never
// hardcoded in sync logic).
// ---------------------------------------------------------------------------

export const pmMappingSchema = z.object({
  task: z.object({
    workItemType: z.string().min(1),
    fields: z.object({
      title: z.string().min(1),
      /** provider-native status field path; state transitions use statusMap */
      status: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      priority: z.string().min(1).optional(),
      acceptanceCriteria: z.string().min(1).optional(),
    }),
    /** RegulAIt node status → provider state name; unmapped = skip, never invent */
    statusMap: z.record(z.string().min(1)).optional(),
  }),
  /** §5: how sign-off decisions appear on the linked item. Absent config or an
   * unmapped stage falls back to a comment — a decision is never silently
   * dropped (§4's fallback rule applied to approvals). */
  approval: z
    .object({
      target: z.enum(["status_transition", "comment"]).default("comment"),
      /** sign-off stage id → provider state (used when target=status_transition) */
      stageMap: z.record(z.string().min(1)).optional(),
    })
    .optional(),
  /** §4: Decision records mirror as a linked work item of the customer's
   * Decision-like type (e.g. "Risk"). Absent = fallback to a tagged comment
   * on the parent item — never a silent drop. */
  decision: z
    .object({
      workItemType: z.string().min(1),
      fields: z.object({
        title: z.string().min(1),
        rationale: z.string().min(1).optional(),
        decisionMaker: z.string().min(1).optional(),
      }),
    })
    .optional(),
});
export type PmMapping = z.infer<typeof pmMappingSchema>;

export type ApprovalMirrorAction = { kind: "transition"; state: string } | { kind: "comment" };

export type DecisionMirrorAction =
  | { kind: "work_item"; type: string; fields: Record<string, unknown> }
  | { kind: "comment" };

/** Pure §4 resolution: a mapped Decision-like type becomes a real linked work
 * item with the minimum fields (decision/rationale/decision-maker); no mapping
 * degrades to a tagged comment on the parent item — never a silent drop. */
export function resolveDecisionAction(
  mapping: PmMapping,
  record: { decision: string; rationale: string | null; decisionMaker: string },
): DecisionMirrorAction {
  const cfg = mapping.decision;
  if (!cfg) return { kind: "comment" };
  const fields: Record<string, unknown> = { [cfg.fields.title]: record.decision };
  if (cfg.fields.rationale && record.rationale !== null) {
    fields[cfg.fields.rationale] = record.rationale;
  }
  if (cfg.fields.decisionMaker) fields[cfg.fields.decisionMaker] = record.decisionMaker;
  return { kind: "work_item", type: cfg.workItemType, fields };
}

/** Pure §5 resolution: a mapped stage under status_transition transitions the
 * item; everything else degrades to a comment — never a silent drop. */
export function resolveApprovalAction(mapping: PmMapping, stageId: string): ApprovalMirrorAction {
  const cfg = mapping.approval;
  if (cfg?.target === "status_transition") {
    const state = cfg.stageMap?.[stageId];
    if (state) return { kind: "transition", state };
  }
  return { kind: "comment" };
}

export function validateMapping(raw: unknown): PmMapping {
  return pmMappingSchema.parse(raw);
}

export const DEFAULT_MAPPINGS: Partial<Record<PmProviderKind, PmMapping>> = {
  linear: {
    task: {
      workItemType: "Issue",
      fields: {
        title: "title",
        status: "state",
        description: "description",
        priority: "priority",
      },
      // Linear's default workflow has no Blocked state — 'blocked' is
      // deliberately unmapped (skip, never invent).
      statusMap: {
        not_started: "Todo",
        in_progress: "In Progress",
        in_review: "In Review",
        done: "Done",
      },
    },
  },
  jira: {
    task: {
      workItemType: "Task",
      fields: {
        title: "summary",
        status: "status",
        description: "description",
        priority: "priority",
      },
      // Jira's default workflow has no Blocked state — 'blocked' is
      // deliberately unmapped (skip, never invent).
      statusMap: {
        not_started: "To Do",
        in_progress: "In Progress",
        in_review: "In Progress",
        done: "Done",
      },
    },
  },
  azure_devops: {
    task: {
      workItemType: "Task",
      fields: {
        title: "System.Title",
        status: "System.State",
        description: "System.Description",
        priority: "Microsoft.VSTS.Common.Priority",
      },
      statusMap: {
        not_started: "To Do",
        in_progress: "Doing",
        blocked: "Blocked",
        in_review: "Doing",
        done: "Done",
      },
    },
  },
  mock: {
    task: {
      workItemType: "Task",
      fields: { title: "title", status: "state", description: "description" },
      statusMap: {
        not_started: "To Do",
        in_progress: "Doing",
        blocked: "Blocked",
        in_review: "Review",
        done: "Done",
      },
    },
  },
};

export function mappingFor(kind: PmProviderKind, override?: unknown): PmMapping {
  if (override !== undefined && override !== null) return validateMapping(override);
  const def = DEFAULT_MAPPINGS[kind];
  if (!def) throw new PmProviderError(`no default field mapping for provider '${kind}'`);
  return def;
}

/** Pure: RegulAIt task concept → provider-native creation payload. Only the
 * title is RegulAIt-authoritative; description is an initial value the PM
 * tool owns from then on (§3). */
export function resolveTaskFields(
  mapping: PmMapping,
  task: { title: string; description?: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = { [mapping.task.fields.title]: task.title };
  if (task.description !== undefined && mapping.task.fields.description) {
    out[mapping.task.fields.description] = task.description;
  }
  return out;
}

/** Pure: RegulAIt node status → provider state, or null when unmapped. */
export function resolveStatus(mapping: PmMapping, nodeStatus: string): string | null {
  return mapping.task.statusMap?.[nodeStatus] ?? null;
}

// ---------------------------------------------------------------------------
// Azure DevOps adapter — REST 7.x, PAT auth, injectable fetch.
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface AdoAdapterOptions {
  token: string;
  /** e.g. https://dev.azure.com/<org> */
  baseUrl: string;
  fetchImpl?: FetchLike;
}

export class AzureDevOpsProvider implements PmProvider {
  readonly kind = "azure_devops" as const;
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: AdoAdapterOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.auth = `Basic ${Buffer.from(`:${opts.token}`).toString("base64")}`;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json",
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: this.auth,
        accept: "application/json",
        "content-type": contentType,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status >= 400) {
      throw new PmProviderError(`ado ${method} ${path} failed: ${await res.text()}`, res.status);
    }
    return res.json();
  }

  async createWorkItem(
    project: string,
    type: string,
    fields: Record<string, unknown>,
  ): Promise<WorkItemRef> {
    const patch = Object.entries(fields).map(([field, value]) => ({
      op: "add",
      path: `/fields/${field}`,
      value,
    }));
    const item = (await this.request(
      "POST",
      `/${project}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`,
      patch,
      "application/json-patch+json",
    )) as { id: number; _links?: { html?: { href?: string } } };
    return { id: String(item.id), url: item._links?.html?.href ?? "" };
  }

  async updateFields(project: string, id: string, fields: Record<string, unknown>): Promise<void> {
    const patch = Object.entries(fields).map(([field, value]) => ({
      op: "add",
      path: `/fields/${field}`,
      value,
    }));
    await this.request(
      "PATCH",
      `/${project}/_apis/wit/workitems/${id}?api-version=7.1`,
      patch,
      "application/json-patch+json",
    );
  }

  async transitionState(project: string, id: string, state: string): Promise<void> {
    await this.updateFields(project, id, { "System.State": state });
  }

  async addComment(project: string, id: string, text: string): Promise<void> {
    await this.request(
      "POST",
      `/${project}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`,
      { text },
    );
  }

  async getWorkItem(project: string, id: string): Promise<WorkItem> {
    const item = (await this.request(
      "GET",
      `/${project}/_apis/wit/workitems/${id}?api-version=7.1`,
    )) as { id: number; fields: Record<string, unknown>; _links?: { html?: { href?: string } } };
    return {
      id: String(item.id),
      url: item._links?.html?.href ?? "",
      type: String(item.fields["System.WorkItemType"] ?? ""),
      state: (item.fields["System.State"] as string) ?? null,
      fields: item.fields,
      comments: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Jira adapter — REST v2 (plain-string fields; v3 would force ADF rich text),
// Basic auth with an "email:api-token" credential (Jira Cloud convention),
// injectable fetch. Jira states are NOT settable fields: transitionState
// looks up the issue's available transitions and executes the matching one,
// failing explicit when the workflow offers no path to the target state.
// ---------------------------------------------------------------------------

export interface JiraAdapterOptions {
  /** "email:api-token" (Jira Cloud Basic auth) */
  token: string;
  /** e.g. https://<site>.atlassian.net */
  baseUrl: string;
  fetchImpl?: FetchLike;
}

export class JiraProvider implements PmProvider {
  readonly kind = "jira" as const;
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: JiraAdapterOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.auth = `Basic ${Buffer.from(opts.token).toString("base64")}`;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: this.auth,
        accept: "application/json",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status >= 400) {
      throw new PmProviderError(`jira ${method} ${path} failed: ${await res.text()}`, res.status);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null; // Jira returns 204/empty on updates
  }

  async createWorkItem(
    project: string,
    type: string,
    fields: Record<string, unknown>,
  ): Promise<WorkItemRef> {
    const created = (await this.request("POST", "/rest/api/2/issue", {
      fields: { project: { key: project }, issuetype: { name: type }, ...fields },
    })) as { id: string; key: string };
    return { id: String(created.id), url: `${this.base}/browse/${created.key}` };
  }

  async updateFields(_project: string, id: string, fields: Record<string, unknown>): Promise<void> {
    await this.request("PUT", `/rest/api/2/issue/${id}`, { fields });
  }

  async transitionState(_project: string, id: string, state: string): Promise<void> {
    const available = (await this.request("GET", `/rest/api/2/issue/${id}/transitions`)) as {
      transitions?: Array<{ id: string; name: string; to?: { name?: string } }>;
    };
    const match = available.transitions?.find((t) => t.to?.name === state || t.name === state);
    if (!match) {
      const names = available.transitions?.map((t) => t.to?.name ?? t.name).join(", ") ?? "none";
      throw new PmProviderError(
        `jira workflow offers no transition to '${state}' (available: ${names})`,
      );
    }
    await this.request("POST", `/rest/api/2/issue/${id}/transitions`, {
      transition: { id: match.id },
    });
  }

  async addComment(_project: string, id: string, text: string): Promise<void> {
    await this.request("POST", `/rest/api/2/issue/${id}/comment`, { body: text });
  }

  async getWorkItem(_project: string, id: string): Promise<WorkItem> {
    const issue = (await this.request("GET", `/rest/api/2/issue/${id}`)) as {
      id: string;
      key: string;
      fields: Record<string, unknown> & {
        issuetype?: { name?: string };
        status?: { name?: string };
        comment?: { comments?: Array<{ body?: string }> };
      };
    };
    return {
      id: String(issue.id),
      url: `${this.base}/browse/${issue.key}`,
      type: issue.fields.issuetype?.name ?? "",
      state: issue.fields.status?.name ?? null,
      fields: issue.fields,
      comments: issue.fields.comment?.comments?.map((c) => c.body ?? "") ?? [],
    };
  }
}

// ---------------------------------------------------------------------------
// Linear adapter — GraphQL-only API (api.linear.app/graphql), raw api-key
// Authorization header, injectable fetch. The interface's `project` is a
// Linear TEAM KEY (resolved to an id once and cached); states are per-team
// workflow states resolved by name, failing explicit with the available list.
// The `type` argument is accepted but Linear issues carry no native type —
// documented, ignored.
// ---------------------------------------------------------------------------

export interface LinearAdapterOptions {
  /** a Linear API key, sent verbatim in the Authorization header */
  token: string;
  /** override for testing/bridges; default https://api.linear.app */
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
}

const LINEAR_DEFAULT_BASE = "https://api.linear.app";

export class LinearProvider implements PmProvider {
  readonly kind = "linear" as const;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly teamIds = new Map<string, string>();

  constructor(opts: LinearAdapterOptions) {
    this.base = (opts.baseUrl ?? LINEAR_DEFAULT_BASE).replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/graphql`, {
      method: "POST",
      headers: {
        authorization: this.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status >= 400) {
      throw new PmProviderError(`linear graphql failed: ${await res.text()}`, res.status);
    }
    const payload = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (payload.errors?.length) {
      throw new PmProviderError(
        `linear graphql failed: ${payload.errors.map((e) => e.message).join("; ")}`,
      );
    }
    return payload.data as T;
  }

  private async teamId(key: string): Promise<string> {
    const cached = this.teamIds.get(key);
    if (cached) return cached;
    const data = await this.gql<{ teams: { nodes: Array<{ id: string }> } }>(
      `query TeamByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`,
      { key },
    );
    const id = data.teams.nodes[0]?.id;
    if (!id) throw new PmProviderError(`linear team with key '${key}' not found`, 404);
    this.teamIds.set(key, id);
    return id;
  }

  async createWorkItem(
    project: string,
    _type: string,
    fields: Record<string, unknown>,
  ): Promise<WorkItemRef> {
    const teamId = await this.teamId(project);
    const data = await this.gql<{
      issueCreate: { success: boolean; issue: { id: string; url: string } };
    }>(
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id url } }
      }`,
      { input: { teamId, ...fields } },
    );
    if (!data.issueCreate.success) throw new PmProviderError("linear issueCreate reported failure");
    return { id: data.issueCreate.issue.id, url: data.issueCreate.issue.url };
  }

  async updateFields(_project: string, id: string, fields: Record<string, unknown>): Promise<void> {
    await this.gql(
      `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id, input: fields },
    );
  }

  async transitionState(project: string, id: string, state: string): Promise<void> {
    const teamId = await this.teamId(project);
    const data = await this.gql<{ team: { states: { nodes: Array<{ id: string; name: string }> } } }>(
      `query TeamStates($teamId: String!) { team(id: $teamId) { states { nodes { id name } } } }`,
      { teamId },
    );
    const match = data.team.states.nodes.find((st) => st.name === state);
    if (!match) {
      const names = data.team.states.nodes.map((st) => st.name).join(", ") || "none";
      throw new PmProviderError(
        `linear team has no workflow state '${state}' (available: ${names})`,
      );
    }
    await this.gql(
      `mutation MoveIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id, input: { stateId: match.id } },
    );
  }

  async addComment(_project: string, id: string, text: string): Promise<void> {
    await this.gql(
      `mutation AddComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }`,
      { input: { issueId: id, body: text } },
    );
  }

  async getWorkItem(_project: string, id: string): Promise<WorkItem> {
    const data = await this.gql<{
      issue: {
        id: string;
        url: string;
        title: string;
        description: string | null;
        priority: number | null;
        state: { name: string } | null;
        comments: { nodes: Array<{ body: string }> };
      };
    }>(
      `query Issue($id: String!) {
        issue(id: $id) {
          id url title description priority
          state { name }
          comments { nodes { body } }
        }
      }`,
      { id },
    );
    return {
      id: data.issue.id,
      url: data.issue.url,
      type: "Issue",
      state: data.issue.state?.name ?? null,
      fields: {
        title: data.issue.title,
        description: data.issue.description,
        priority: data.issue.priority,
        state: data.issue.state?.name ?? null,
      },
      comments: data.issue.comments.nodes.map((c) => c.body),
    };
  }
}

// ---------------------------------------------------------------------------
// Mock adapter — in-memory, for tests and air-gapped development.
// ---------------------------------------------------------------------------

interface MockItem {
  id: string;
  type: string;
  state: string | null;
  fields: Record<string, unknown>;
  comments: string[];
}

export class MockPmProvider implements PmProvider {
  readonly kind = "mock" as const;
  readonly projects = new Map<string, Map<string, MockItem>>();
  private nextId = 1;

  private project(name: string): Map<string, MockItem> {
    let p = this.projects.get(name);
    if (!p) {
      p = new Map();
      this.projects.set(name, p);
    }
    return p;
  }

  async createWorkItem(
    project: string,
    type: string,
    fields: Record<string, unknown>,
  ): Promise<WorkItemRef> {
    const id = String(this.nextId++);
    this.project(project).set(id, {
      id,
      type,
      state: (fields.state as string) ?? "To Do",
      fields,
      comments: [],
    });
    return { id, url: `mock-pm://${project}/items/${id}` };
  }

  private itemOrThrow(project: string, id: string): MockItem {
    const item = this.project(project).get(id);
    if (!item) throw new PmProviderError(`unknown work item '${id}'`, 404);
    return item;
  }

  async updateFields(project: string, id: string, fields: Record<string, unknown>): Promise<void> {
    Object.assign(this.itemOrThrow(project, id).fields, fields);
  }

  async transitionState(project: string, id: string, state: string): Promise<void> {
    this.itemOrThrow(project, id).state = state;
  }

  async addComment(project: string, id: string, text: string): Promise<void> {
    this.itemOrThrow(project, id).comments.push(text);
  }

  async getWorkItem(project: string, id: string): Promise<WorkItem> {
    const item = this.itemOrThrow(project, id);
    return { ...item, url: `mock-pm://${project}/items/${item.id}` };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface PmConnectionConfig {
  provider: PmProviderKind;
  token: string;
  baseUrl?: string | null;
}

/** shared mock instance so state persists across resolutions in one process */
const sharedMock = new MockPmProvider();

export function resolvePmProvider(config: PmConnectionConfig, fetchImpl?: FetchLike): PmProvider {
  switch (config.provider) {
    case "azure_devops":
      if (!config.baseUrl) {
        throw new PmProviderError("azure_devops requires a baseUrl (https://dev.azure.com/<org>)");
      }
      return new AzureDevOpsProvider({
        token: config.token,
        baseUrl: config.baseUrl,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "jira":
      if (!config.baseUrl) {
        throw new PmProviderError("jira requires a baseUrl (https://<site>.atlassian.net)");
      }
      return new JiraProvider({
        token: config.token,
        baseUrl: config.baseUrl,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "linear":
      return new LinearProvider({
        token: config.token,
        baseUrl: config.baseUrl ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "mock":
      return sharedMock;
    case "asana":
    case "monday":
    case "generic_webhook":
      throw new PmProviderError(
        `provider '${config.provider}' is interface-ready but its adapter is not implemented yet`,
      );
  }
}
