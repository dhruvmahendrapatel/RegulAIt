/**
 * ADR-0173 batch 2b — a stateful, in-test mock of the prompt registry
 * (/v1/prompts*), the playground (/v1/playground/*) and outbound webhooks
 * (/v1/webhooks*), layered over the Builder mock (which answers sign-in,
 * models, the directory and projects). Shapes, status codes and error codes
 * mirror apps/gateway/src/prompt-registry.ts, playground.ts and
 * outbound-webhooks.ts; every call is recorded so a spec can assert what the
 * page sent. Not a spec itself.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, type Route } from "@playwright/test";
import { CORA, DREW, installBuilderMock, ME, MODEL_A, MODEL_B, type MockOptions } from "./builder-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const P1 = "77777777-0000-4000-8000-000000000001";
export const P2 = "77777777-0000-4000-8000-000000000002";
export const H1 = "1a".repeat(32);
export const H2 = "2b".repeat(32);
export const DATASET = "88888888-0000-4000-8000-000000000001";
const NAMES: Record<string, string> = { [ME]: "Avery Admin", [DREW]: "Drew Reviewer", [CORA]: "Cora Analyst" };
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
let seq = 0;
const hex64 = () => (++seq).toString(16).padStart(4, "0").repeat(16);
const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g;
const varsOf = (t: string) => [...new Set([...t.matchAll(VAR_RE)].map((m) => m[1]!))];

export const TEMPLATE_1 = "Summarise {{document}} for {{audience}}.";
export const TEMPLATE_2 = "Summarise {{document}} for {{audience}}.\nUse three bullet points.";

export interface PromptMockOptions extends MockOptions {
  /** the org's model-policy rules (default: none) */
  policyRules?: Json[];
}

function commit(over: Partial<Json>): Json {
  return {
    id: `c-${hex64().slice(0, 8)}`,
    hash: hex64(),
    parentHash: null,
    template: TEMPLATE_1,
    modelConfig: { agentId: MODEL_A, maxTokens: null },
    variables: varsOf(over.template ?? TEMPLATE_1),
    outputSchema: null,
    tools: [],
    authorUserId: ME,
    authorName: NAMES[ME],
    message: "first version",
    createdAt: iso(60),
    ...over,
  };
}

export function seedPrompts() {
  const c1 = commit({ hash: H1, message: "first version", createdAt: iso(120) });
  const c2 = commit({ hash: H2, parentHash: H1, template: TEMPLATE_2, variables: varsOf(TEMPLATE_2), authorUserId: DREW, authorName: NAMES[DREW], message: "three bullets", createdAt: iso(30) });
  return [
    {
      id: P1,
      name: "use-case-summary",
      description: "Summarises an AI use case for reviewers.",
      ownerUserId: ME,
      visibility: "workspace",
      projectId: null,
      sharedUserIds: [] as string[],
      commits: [c2, c1],
      tags: [
        { name: "prod", commitHash: H1, movedByUserId: DREW, movedAt: iso(100) },
        { name: "staging", commitHash: H2, movedByUserId: ME, movedAt: iso(20) },
      ],
      promotions: [] as Json[],
      archived: false,
      createdAt: iso(200),
      updatedAt: iso(20),
    },
    {
      id: P2,
      name: "vendor-brief",
      description: "Drew's vendor briefing prompt.",
      ownerUserId: DREW,
      visibility: "workspace",
      projectId: null,
      sharedUserIds: [] as string[],
      commits: [commit({ template: "Brief on {{vendor}}.", variables: ["vendor"], authorUserId: DREW, authorName: NAMES[DREW], message: "draft" })],
      tags: [],
      promotions: [],
      archived: false,
      createdAt: iso(300),
      updatedAt: iso(300),
    },
  ];
}

export type PromptState = { prompts: ReturnType<typeof seedPrompts>; calls: Array<{ method: string; path: string; body: Json }>; isAdmin: boolean };

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: body === undefined ? "" : JSON.stringify(body) });

export async function installPromptsMock(page: Page, opts: PromptMockOptions = {}): Promise<PromptState> {
  const base = await installBuilderMock(page, opts);
  const st: PromptState = { prompts: seedPrompts(), calls: [], isAdmin: base.isAdmin };
  const canEdit = (p: Json) => st.isAdmin || p.ownerUserId === ME;
  const summary = (p: Json) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    visibility: p.visibility,
    ownerUserId: p.ownerUserId,
    ownerName: NAMES[p.ownerUserId] ?? null,
    projectId: p.projectId,
    latestCommitHash: p.commits[0]?.hash ?? null,
    latestCommitAt: p.commits[0]?.createdAt ?? null,
    tags: p.tags.map((t: Json) => ({ name: t.name, commitHash: t.commitHash })),
    canEdit: canEdit(p),
    updatedAt: p.updatedAt,
  });
  const detail = (p: Json) => ({
    prompt: {
      id: p.id,
      name: p.name,
      description: p.description,
      ownerUserId: p.ownerUserId,
      ownerName: NAMES[p.ownerUserId] ?? null,
      visibility: p.visibility,
      projectId: p.projectId,
      sharedUsers: p.sharedUserIds.map((id: string) => ({ id, name: NAMES[id] ?? null })),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      canEdit: canEdit(p),
    },
    commits: p.commits,
    tags: p.tags.map((t: Json) => ({ ...t, movedByName: NAMES[t.movedByUserId] ?? null })),
    promotions: p.promotions,
  });

  // registered after the Builder mock, so it is consulted first; anything it
  // does not own falls through to the Builder mock
  await page.route(/\/v1\/(prompts|playground|evals\/datasets|model-policy)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    let body: Json = undefined;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    st.calls.push({ method, path: p + url.search, body });
    let m: RegExpExecArray | null;

    if (p === "/v1/model-policy") return json(route, { scope: "you", updatedAt: null, rules: opts.policyRules ?? [] });
    if (p === "/v1/evals/datasets") {
      if (!st.isAdmin) return json(route, { error: "forbidden" }, 403);
      return json(route, { datasets: [{ id: DATASET, name: "intake-cases", version: 2, caseCount: 3 }], note: "" });
    }

    // ---- registry
    const visible = st.prompts.filter((x) => !x.archived);
    if (p === "/v1/prompts" && method === "GET") return json(route, { prompts: visible.map(summary) });
    if (p === "/v1/prompts" && method === "POST") {
      if (st.prompts.some((x) => x.name.toLowerCase() === String(body.name).toLowerCase()))
        return json(route, { error: "duplicate_name", detail: `a prompt named '${body.name}' already exists` }, 409);
      const created = {
        id: `77777777-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
        name: body.name,
        description: body.description,
        ownerUserId: ME,
        visibility: body.visibility,
        projectId: body.projectId,
        sharedUserIds: body.sharedUserIds,
        commits: [],
        tags: [],
        promotions: [],
        archived: false,
        createdAt: iso(0),
        updatedAt: iso(0),
      };
      st.prompts.push(created as Json);
      return json(route, detail(created), 201);
    }
    if ((m = /^\/v1\/prompts\/([^/]+)(?:\/(commits|diff|tags)(?:\/([^/]+))?)?$/.exec(p))) {
      const pr = visible.find((x) => x.id === m![1]);
      if (!pr) return json(route, { error: "unknown_prompt" }, 404);
      const what = m[2];
      if (!what && method === "GET") return json(route, detail(pr));
      if (!what && method === "PATCH") {
        if (!canEdit(pr)) return json(route, { error: "not_prompt_owner" }, 403);
        Object.assign(pr, {
          ...(body.visibility ? { visibility: body.visibility } : {}),
          ...(body.sharedUserIds ? { sharedUserIds: body.sharedUserIds } : {}),
          updatedAt: iso(0),
        });
        return json(route, detail(pr));
      }
      if (!what && method === "DELETE") {
        if (!canEdit(pr)) return json(route, { error: "not_prompt_owner" }, 403);
        if (pr.promotions.some((x: Json) => x.status === "pending_approval"))
          return json(route, { error: "promotion_pending", detail: "a promotion of this prompt is waiting on the approvals queue; decide it first" }, 409);
        pr.archived = true;
        return json(route, { archived: true, id: pr.id });
      }
      if (what === "commits" && method === "POST") {
        if (!canEdit(pr)) return json(route, { error: "not_prompt_owner" }, 403);
        if (body.parentHash === null && pr.commits.length)
          return json(route, { error: "parent_required", detail: "this prompt has commits; name the commit you edited (parentHash)" }, 409);
        const c = commit({ ...body, variables: varsOf(body.template), authorUserId: ME, authorName: NAMES[ME], createdAt: iso(0) });
        pr.commits.unshift(c);
        return json(route, c, 201);
      }
      if (what === "diff" && method === "GET") {
        return json(route, {
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          template: [
            { op: "same", text: "Summarise {{document}} for {{audience}}.\n" },
            { op: "add", text: "Use three bullet points." },
          ],
          variables: { added: [], removed: [] },
          modelConfig: null,
          outputSchema: null,
          tools: { added: [], removed: [], changed: [] },
        });
      }
      if (what === "tags" && method === "PUT") {
        const tag = decodeURIComponent(m[3]!);
        if (!canEdit(pr)) return json(route, { error: "not_prompt_owner", detail: "tags are moved by the prompt's owner or an admin" }, 403);
        const c = pr.commits.find((x: Json) => x.hash === body.commitHash);
        if (!c) return json(route, { error: "unknown_commit", field: "commitHash" }, 422);
        const cur = pr.tags.find((t: Json) => t.name === tag);
        if (tag !== "prod") {
          if (cur) Object.assign(cur, { commitHash: c.hash, movedByUserId: ME, movedAt: iso(0) });
          else pr.tags.push({ name: tag, commitHash: c.hash, movedByUserId: ME, movedAt: iso(0) });
          return json(route, { moved: true, tag, commitHash: c.hash, previousCommitHash: cur?.commitHash ?? null });
        }
        if (!body.approverUserId) return json(route, { error: "approver_required", detail: "moving prod needs an approver who did not write the commit" }, 422);
        if (body.approverUserId === c.authorUserId) return json(route, { error: "approver_is_author", detail: "the approver may not be the commit's author; name someone else" }, 409);
        const promo = {
          id: `pr-${hex64().slice(0, 8)}`,
          tag,
          commitHash: c.hash,
          previousCommitHash: cur?.commitHash ?? null,
          status: "pending_approval",
          approvalId: "99999999-0000-4000-8000-000000000001",
          requestedByUserId: ME,
          requestedByName: NAMES[ME],
          approverUserId: body.approverUserId,
          approverName: NAMES[body.approverUserId] ?? null,
          decidedByUserId: null,
          decidedByName: null,
          decidedAt: null,
          result: null,
          createdAt: iso(0),
        };
        pr.promotions.unshift(promo);
        return json(route, { moved: false, pendingApproval: true, promotion: promo }, 202);
      }
    }

    // ---- playground
    if (p === "/v1/playground/run" && method === "POST") {
      if (body.modelAgentId === MODEL_B)
        return json(route, { error: "model_not_allowed_for_feature", detail: "the organisation's model policy does not allow this model for the playground" }, 403);
      if (body.variables?.document === "over budget")
        return json(route, { error: "project_budget_exceeded", detail: "the project's monthly budget is spent" }, 402);
      const structured = !!body.outputSchema;
      return json(route, {
        outputText: structured ? '{"summary":"ok"}' : `Summary for ${body.variables?.audience ?? "you"}: fine.`,
        toolCalls: body.tools?.length ? [{ id: "call-1", name: body.tools[0].name, arguments: { query: "vendor risk" } }] : [],
        toolCallsExecuted: false,
        toolCallsNote: "Tool calls are shown as the model made them and are not executed in the playground.",
        structuredOutput: structured ? "native" : null,
        schemaValidation: structured ? { valid: true, errors: [] } : null,
        usage: { inputTokens: 42, outputTokens: 12 },
        costUsd: 0.0021,
        servedAgentId: body.modelAgentId,
        model: "claude-sonnet",
        variables: varsOf(body.template),
      });
    }
    if (p === "/v1/playground/evaluate" && method === "POST") {
      const rows: Json[] = body.datasetId
        ? [{ inputs: { document: "case 1" }, reference: "ok" }, { inputs: { document: "case 2" }, reference: null }]
        : body.rows;
      const results = rows.map((r: Json, index: number) => ({
        index,
        inputs: r.inputs,
        reference: r.reference,
        ok: true,
        error: null,
        detail: null,
        outputText: `out ${index + 1}`,
        toolCalls: [],
        costUsd: 0.01,
        schemaValidation: null,
        referenceMatch: r.reference ? (r.reference === `out ${index + 1}` ? "exact" : "no") : null,
      }));
      return json(route, {
        source: body.datasetId ? { kind: "dataset", datasetId: DATASET, name: "intake-cases", version: 2 } : { kind: "inline" },
        summary: {
          rows: results.length,
          succeeded: results.length,
          failed: 0,
          totalCostUsd: Number((0.01 * results.length).toFixed(8)),
          unpricedCalls: 0,
          schemaPassed: 0,
          referenceMatched: results.filter((r: Json) => r.referenceMatch === "exact").length,
          withReference: results.filter((r: Json) => r.reference).length,
        },
        results,
        toolCallsExecuted: false,
        toolCallsNote: "",
        structuredOutput: null,
      });
    }
    return route.fallback();
  });
  return st;
}

export const sentTo = (st: { calls: Array<{ method: string; path: string; body: Json }> }, method: string, path: string) =>
  st.calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);

const THEMES = ["light", "dark"] as const;
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    // wait for the finite transitions the flip starts; an infinite animation
    // never finishes and an unrendered one never advances, so cap the wait
    const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
    const settled = Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** axe (WCAG 2.x A/AA) in light AND dark */
export async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map(
      (v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.split("\n")[1] ?? ""}`).join("\n    ")}`,
    );
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
  await setTheme(page, "light");
}
