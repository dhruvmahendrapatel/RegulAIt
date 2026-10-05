/**
 * ADR-0173 batch 2b — the governed prompt registry, end to end.
 *
 * Every rule below is asserted with its positive control beside it:
 *  - visibility follows the builder model (private / workspace / people /
 *    admin), plus a promotion's named approver; an identity-less token is refused;
 *  - commits are content-addressed: the hash is the shared promptCommitHash of
 *    {template, model config, variables, output schema, tools, parent};
 *    identical content on the same parent is refused, a second root is refused;
 *  - any two commits diff;
 *  - a non-prod tag moves directly, by the owner or an admin only;
 *  - moving prod never moves the tag in the request: it queues a
 *    prompt_promotion approval bound to the (prompt, tag, commit hash) digest;
 *    the approver is never the commit's author — at request time AND in the
 *    decide path (an admin override by the author is refused too);
 *  - the tag moves only in the decide hook, only if the binding still holds;
 *    deny moves nothing;
 *  - every commit / tag move / promotion emits a webhook event whose payload
 *    carries ids, names and hashes only — never the template.
 *
 * Shared state: the one webhook subscription this file inserts is deleted in
 * afterAll (its deliveries cascade); every other row is this run's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, approvals, auditLog, eq, promptPromotions, promptTags, prompts, webhookDeliveries, webhookSubscriptions } from "@regulait/db";
import { extractPromptVariables, promptCommitHash, promptPromotionDigest } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { drainBackgroundWork } from "./background-work.js";
import { encryptSecret } from "./secrets.js";
import { newWebhookSecret } from "./outbound-webhooks.js";

let k: BuilderKit;
let owner: Person;
let reviewer: Person;
let outsider: Person;
let coworker: Person;
let admin: Person;
let subscriptionId = "";

const TEMPLATE_V1 = "Summarise {{document}} for {{audience}}. SECRET-TEMPLATE-MARKER-v1";
const TEMPLATE_V2 = "Summarise {{document}} for {{audience}} in {{length}} words.\nBe precise. SECRET-TEMPLATE-MARKER-v2";

async function createPrompt(who: Person, name: string, extra: Record<string, unknown> = {}) {
  const r = await k.req("POST", "/v1/prompts", who.auth, { name: `${name}-${k.RUN}`, description: "test prompt", ...extra });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().prompt.id as string;
}

async function commit(who: Person, promptId: string, template: string, parentHash: string | null, extra: Record<string, unknown> = {}) {
  return k.req("POST", `/v1/prompts/${promptId}/commits`, who.auth, { template, parentHash, message: "edit", ...extra });
}

const tagOf = async (promptId: string, tag: string) => {
  const r = await k.req("GET", `/v1/prompts/${promptId}`, admin.auth);
  return (r.json().tags as Array<{ name: string; commitHash: string }>).find((t) => t.name === tag)?.commitHash ?? null;
};

const decide = (who: Person, approvalId: string, decision: "approved" | "denied", reason?: string) =>
  k.req("POST", `/v1/approvals/${approvalId}/decide`, who.auth, { decision, ...(reason ? { reason } : {}) });

beforeAll(async () => {
  k = await builderKit("preg");
  owner = await k.person("owner");
  reviewer = await k.person("reviewer");
  outsider = await k.person("outsider");
  coworker = await k.person("coworker");
  admin = await k.person("admin", { admin: true });
  // a subscription to every prompt event, so emissions land in the delivery log
  // (its URL is never allow-listed: the rows are what this file reads)
  const [sub] = await k.db
    .insert(webhookSubscriptions)
    .values({
      name: `preg-${k.RUN}`,
      url: "https://hooks.preg.invalid/in",
      events: ["prompt.*"],
      secretCiphertext: encryptSecret("a".repeat(64), newWebhookSecret()),
    })
    .returning();
  subscriptionId = sub!.id;
});

afterAll(async () => {
  await drainBackgroundWork(k.db);
  await k.db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId));
  await k.close();
});

const deliveries = async (event: string) =>
  k.db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.subscriptionId, subscriptionId), eq(webhookDeliveries.event, event)));

describe("identity and visibility", () => {
  it("refuses a token with no user identity", async () => {
    const r = await k.req("GET", "/v1/prompts", k.BOOT);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("prompt_requires_identity");
  });

  it("private is the owner's and admins'; workspace is everyone's; people is the named people's", async () => {
    const priv = await createPrompt(owner, "vis-private");
    const ws = await createPrompt(owner, "vis-workspace", { visibility: "workspace" });
    const ppl = await createPrompt(owner, "vis-people", { visibility: "people", sharedUserIds: [coworker.id] });

    for (const [who, id, code] of [
      [owner, priv, 200], [admin, priv, 200], [outsider, priv, 404], [coworker, priv, 404],
      [outsider, ws, 200], [coworker, ppl, 200], [outsider, ppl, 404],
    ] as Array<[Person, string, number]>) {
      const r = await k.req("GET", `/v1/prompts/${id}`, who.auth);
      expect(r.statusCode, `${id} ${r.body}`).toBe(code);
    }
    const listed = (await k.req("GET", "/v1/prompts", outsider.auth)).json().prompts.map((p: { id: string }) => p.id);
    expect(listed).toContain(ws);
    expect(listed).not.toContain(priv);
    expect(listed).not.toContain(ppl);
    // a reader is not an editor
    const edit = await k.req("PATCH", `/v1/prompts/${ws}`, outsider.auth, { description: "mine now" });
    expect(edit.statusCode).toBe(403);
  });
});

describe("commits", () => {
  it("hashes exactly the declared content, derives variables, and keeps one root", async () => {
    const id = await createPrompt(owner, "commits");
    const tools = [{ name: "lookup", description: "find a record", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
    const outputSchema = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
    const r1 = await commit(owner, id, TEMPLATE_V1, null, { tools, outputSchema });
    expect(r1.statusCode, r1.body).toBe(201);
    const c1 = r1.json();
    expect(c1.variables).toEqual(["document", "audience"]);
    expect(c1.hash).toBe(
      promptCommitHash({
        template: TEMPLATE_V1,
        modelConfig: { agentId: null, maxTokens: null },
        variables: extractPromptVariables(TEMPLATE_V1),
        outputSchema,
        tools,
        parent: null,
      }),
    );
    // a second root is refused by name; the same content on the same parent is a duplicate
    const root2 = await commit(owner, id, TEMPLATE_V2, null);
    expect(root2.statusCode).toBe(409);
    expect(root2.json().error).toBe("parent_required");
    const r2 = await commit(owner, id, TEMPLATE_V2, c1.hash);
    expect(r2.statusCode, r2.body).toBe(201);
    const dup = await commit(owner, id, TEMPLATE_V2, c1.hash);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("identical_commit");
    // an unknown parent, a non-owner, and a schema that does not compile are refused
    expect((await commit(owner, id, "x {{y}}", "f".repeat(64))).json().error).toBe("unknown_parent");
    expect((await commit(outsider, id, "x", c1.hash)).statusCode).toBe(404);
    const badSchema = await commit(owner, id, "x", c1.hash, { outputSchema: { type: "no-such-type" } });
    expect(badSchema.statusCode).toBe(422);
    expect(badSchema.json().error).toBe("invalid_json_schema");

    // the diff of any two commits
    const d = await k.req("GET", `/v1/prompts/${id}/diff?from=${c1.hash}&to=${r2.json().hash}`, owner.auth);
    expect(d.statusCode, d.body).toBe(200);
    const diff = d.json();
    expect(diff.variables).toEqual({ added: ["length"], removed: [] });
    expect(diff.tools.removed).toEqual(["lookup"]);
    expect(diff.outputSchema).not.toBeNull();
    expect(diff.template.some((p: { op: string; text: string }) => p.op === "add" && p.text.includes("Be precise"))).toBe(true);
    expect(diff.template.some((p: { op: string }) => p.op === "remove")).toBe(true);

    // the commit event: ids, names and hashes — never the template
    const ev = (await deliveries("prompt.commit")).filter((d) => d.payload.promptId === id);
    expect(ev).toHaveLength(2);
    expect(ev.map((e) => e.payload.commitHash).sort()).toEqual([c1.hash, r2.json().hash].sort());
    expect(Object.keys(ev[0]!.payload).sort()).toEqual(["authorUserId", "commitHash", "occurredAt", "parentHash", "promptId", "promptName"]);
    expect(JSON.stringify(ev)).not.toContain("SECRET-TEMPLATE-MARKER");
    const audits = await k.db.select().from(auditLog).where(and(eq(auditLog.objectType, "prompt"), eq(auditLog.objectId, id), eq(auditLog.ruleId, "prompt-committed")));
    expect(audits).toHaveLength(2);
  });
});

describe("tags", () => {
  let id = "";
  let h1 = "";
  let h2 = "";
  beforeAll(async () => {
    id = await createPrompt(owner, "tags", { visibility: "workspace" });
    h1 = (await commit(owner, id, TEMPLATE_V1, null)).json().hash;
    h2 = (await commit(owner, id, TEMPLATE_V2, h1)).json().hash;
  });

  it("a non-prod tag moves directly, by the owner or an admin — not by a reader", async () => {
    const byReader = await k.req("PUT", `/v1/prompts/${id}/tags/staging`, outsider.auth, { commitHash: h1 });
    expect(byReader.statusCode).toBe(403);
    expect(await tagOf(id, "staging")).toBeNull();
    const byOwner = await k.req("PUT", `/v1/prompts/${id}/tags/staging`, owner.auth, { commitHash: h1 });
    expect(byOwner.statusCode, byOwner.body).toBe(200);
    expect(await tagOf(id, "staging")).toBe(h1);
    const byAdmin = await k.req("PUT", `/v1/prompts/${id}/tags/staging`, admin.auth, { commitHash: h2 });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(await tagOf(id, "staging")).toBe(h2);
    const moved = (await deliveries("prompt.tag.moved")).filter((d) => d.payload.promptId === id);
    expect(moved.map((m) => m.payload.commitHash)).toEqual(expect.arrayContaining([h1, h2]));
    // `prompt@tag` resolves to the commit the tag points at, for someone who may see it
    const res = await k.req("GET", `/v1/prompts/resolve?ref=${encodeURIComponent(`tags-${k.RUN}@staging`)}`, outsider.auth);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().commit.hash).toBe(h2);
  });

  it("prod never moves in the request: it needs an approver who is not the author or the requester", async () => {
    const none = await k.req("PUT", `/v1/prompts/${id}/tags/prod`, owner.auth, { commitHash: h1 });
    expect(none.json().error).toBe("approver_required");
    // the owner wrote h1; an admin requesting with the owner as approver is refused
    const author = await k.req("PUT", `/v1/prompts/${id}/tags/prod`, admin.auth, { commitHash: h1, approverUserId: owner.id });
    expect(author.statusCode).toBe(409);
    expect(author.json().error).toBe("approver_is_author");
    expect(await tagOf(id, "prod")).toBeNull();
  });

  it("approve moves prod to exactly the bound commit, through the one queue", async () => {
    const req = await k.req("PUT", `/v1/prompts/${id}/tags/prod`, owner.auth, { commitHash: h1, approverUserId: reviewer.id });
    expect(req.statusCode, req.body).toBe(202);
    const promo = req.json().promotion;
    expect(await tagOf(id, "prod")).toBeNull();
    const [row] = await k.db.select().from(approvals).where(eq(approvals.id, promo.approvalId));
    expect(row!.objectType).toBe("prompt_promotion");
    expect(row!.approverUserId).toBe(reviewer.id);
    expect(row!.argumentsDigest).toBe(promptPromotionDigest({ promptId: id, tag: "prod", commitHash: h1 }));
    // a second request while one is pending is refused
    const again = await k.req("PUT", `/v1/prompts/${id}/tags/prod`, owner.auth, { commitHash: h2, approverUserId: reviewer.id });
    expect(again.json().error).toBe("promotion_pending");
    // the approver can read what they are asked to promote, though the prompt is not shared with them
    expect((await k.req("GET", `/v1/prompts/${id}`, reviewer.auth)).statusCode).toBe(200);

    const ok = await decide(reviewer, promo.approvalId, "approved");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await tagOf(id, "prod")).toBe(h1);
    const [after] = await k.db.select().from(promptPromotions).where(eq(promptPromotions.id, promo.id));
    expect(after!.status).toBe("applied");
    const [tag] = await k.db.select().from(promptTags).where(and(eq(promptTags.promptId, id), eq(promptTags.name, "prod")));
    expect(tag!.movedByUserId).toBe(reviewer.id);
    await drainBackgroundWork(k.db);
    const decided = (await deliveries("prompt.promotion.decided")).filter((d) => d.payload.approvalId === promo.approvalId);
    expect(decided).toHaveLength(1);
    expect(decided[0]!.payload).toMatchObject({ decision: "approved", outcome: "applied", commitHash: h1, tag: "prod" });
    expect((await deliveries("prompt.promotion.requested")).some((d) => d.payload.approvalId === promo.approvalId)).toBe(true);
  });

  it("deny moves nothing", async () => {
    const req = await k.req("PUT", `/v1/prompts/${id}/tags/prod`, owner.auth, { commitHash: h2, approverUserId: reviewer.id });
    expect(req.statusCode, req.body).toBe(202);
    const promo = req.json().promotion;
    const no = await decide(reviewer, promo.approvalId, "denied", "not yet");
    expect(no.statusCode, no.body).toBe(200);
    expect(await tagOf(id, "prod")).toBe(h1);
    const [after] = await k.db.select().from(promptPromotions).where(eq(promptPromotions.id, promo.id));
    expect(after!.status).toBe("denied");
  });

  it("the author cannot decide the promotion of their own commit, even as an admin overriding", async () => {
    // an admin-authored commit, so the author can reach the decide path at all
    const adminPrompt = await createPrompt(admin, "sod");
    const ha = (await commit(admin, adminPrompt, "admin wrote {{this}}", null)).json().hash;
    const req = await k.req("PUT", `/v1/prompts/${adminPrompt}/tags/prod`, admin.auth, { commitHash: ha, approverUserId: reviewer.id });
    expect(req.statusCode, req.body).toBe(202);
    const promo = req.json().promotion;
    const self = await decide(admin, promo.approvalId, "approved", "admin override");
    expect(self.statusCode, self.body).toBe(403);
    expect(self.json().error).toBe("cannot_approve_own_prompt_commit");
    expect(await tagOf(adminPrompt, "prod")).toBeNull();
    // the positive control: the named approver decides it
    const ok = await decide(reviewer, promo.approvalId, "approved");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await tagOf(adminPrompt, "prod")).toBe(ha);
  });

  it("an approval whose binding no longer matches moves nothing and records the promotion stale", async () => {
    const p2 = await createPrompt(owner, "binding");
    const b1 = (await commit(owner, p2, "first {{x}}", null)).json().hash;
    const b2 = (await commit(owner, p2, "second {{x}}", b1)).json().hash;
    const req = await k.req("PUT", `/v1/prompts/${p2}/tags/prod`, owner.auth, { commitHash: b1, approverUserId: reviewer.id });
    expect(req.statusCode, req.body).toBe(202);
    const promo = req.json().promotion;
    // the stored request is re-pointed at another commit after it was queued
    const [other] = await k.db.select().from(promptPromotions).where(eq(promptPromotions.id, promo.id));
    const { promptCommits } = await import("@regulait/db");
    const [c2] = await k.db.select().from(promptCommits).where(and(eq(promptCommits.promptId, p2), eq(promptCommits.hash, b2)));
    await k.db.update(promptPromotions).set({ commitId: c2!.id, commitHash: b2 }).where(eq(promptPromotions.id, other!.id));
    const ok = await decide(reviewer, promo.approvalId, "approved");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await tagOf(p2, "prod")).toBeNull();
    const [after] = await k.db.select().from(promptPromotions).where(eq(promptPromotions.id, promo.id));
    expect(after!.status).toBe("stale");
    expect(after!.result).toMatchObject({ reason: "binding_mismatch" });
    const stale = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, p2), eq(auditLog.ruleId, "prompt-promotion-stale")));
    expect(stale).toHaveLength(1);
  });

  it("archiving is the owner's, refused while a promotion waits, and hides the prompt", async () => {
    const p3 = await createPrompt(owner, "archive", { visibility: "workspace" });
    const a1 = (await commit(owner, p3, "a {{x}}", null)).json().hash;
    const req = await k.req("PUT", `/v1/prompts/${p3}/tags/prod`, owner.auth, { commitHash: a1, approverUserId: reviewer.id });
    expect((await k.req("DELETE", `/v1/prompts/${p3}`, outsider.auth)).statusCode).toBe(403);
    const blocked = await k.req("DELETE", `/v1/prompts/${p3}`, owner.auth);
    expect(blocked.json().error).toBe("promotion_pending");
    await decide(reviewer, req.json().promotion.approvalId, "denied", "no");
    const ok = await k.req("DELETE", `/v1/prompts/${p3}`, owner.auth);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await k.req("GET", `/v1/prompts/${p3}`, owner.auth)).statusCode).toBe(404);
    const [row] = await k.db.select().from(prompts).where(eq(prompts.id, p3));
    expect(row!.archivedAt).not.toBeNull();
  });
});

describe("separation of duties covers every commit the promotion carries (no laundering through a child commit)", () => {
  // alice is an admin who writes a commit on the owner's prompt; the owner
  // then commits a child of it. Promoting the child carries alice's change too.
  let alice: Person;
  let pid = "";
  let c1 = "";
  let c2 = "";
  let c3 = "";
  beforeAll(async () => {
    alice = await k.person("alice", { admin: true });
    pid = await createPrompt(owner, "launder");
    c1 = (await commit(admin, pid, "base {{x}}", null)).json().hash;
    // prod holds c1 (written by `admin`), approved by the reviewer
    const first = await k.req("PUT", `/v1/prompts/${pid}/tags/prod`, owner.auth, { commitHash: c1, approverUserId: reviewer.id });
    expect(first.statusCode, first.body).toBe(202);
    expect((await decide(reviewer, first.json().promotion.approvalId, "approved")).statusCode).toBe(200);
    expect(await tagOf(pid, "prod")).toBe(c1);
    const r2 = await commit(alice, pid, "base {{x}} MALICIOUS", c1);
    expect(r2.statusCode, r2.body).toBe(201);
    c2 = r2.json().hash;
    c3 = (await commit(owner, pid, "base {{x}} MALICIOUS, tidied", c2)).json().hash;
  });

  it("refuses, at request time, an approver who wrote a commit between prod and the promoted one", async () => {
    const r = await k.req("PUT", `/v1/prompts/${pid}/tags/prod`, owner.auth, { commitHash: c3, approverUserId: alice.id });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("approver_is_author");
    expect(await tagOf(pid, "prod")).toBe(c1);
  });

  it("refuses alice deciding it by admin override, and the walk stops at prod (prod's author may approve)", async () => {
    // `admin` wrote c1 only, which prod already holds: outside the range
    const req = await k.req("PUT", `/v1/prompts/${pid}/tags/prod`, owner.auth, { commitHash: c3, approverUserId: admin.id });
    expect(req.statusCode, req.body).toBe(202);
    const approvalId = req.json().promotion.approvalId as string;
    const self = await decide(alice, approvalId, "approved", "admin override");
    expect(self.statusCode, self.body).toBe(403);
    expect(self.json().error).toBe("cannot_approve_own_prompt_commit");
    expect(await tagOf(pid, "prod")).toBe(c1);
    const ok = await decide(admin, approvalId, "approved");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await tagOf(pid, "prod")).toBe(c3);
  });

  it("holds inside the decide hook itself: a decider who wrote a commit in the range moves nothing", async () => {
    const { applyPromptPromotionDecision } = await import("./prompt-registry.js");
    const p = await createPrompt(owner, "launder-hook");
    const h1 = (await commit(alice, p, "one {{x}}", null)).json().hash;
    const h2 = (await commit(owner, p, "two {{x}}", h1)).json().hash;
    const req = await k.req("PUT", `/v1/prompts/${p}/tags/prod`, owner.auth, { commitHash: h2, approverUserId: reviewer.id });
    expect(req.statusCode, req.body).toBe(202);
    const [ap] = await k.db.select().from(approvals).where(eq(approvals.id, req.json().promotion.approvalId));
    // reach the hook directly, as a path that skipped the precheck would
    await applyPromptPromotionDecision(k.db, ap!, "approved", alice.id, "a".repeat(64));
    expect(await tagOf(p, "prod")).toBeNull();
    const [after] = await k.db.select().from(promptPromotions).where(eq(promptPromotions.approvalId, ap!.id));
    expect(after!.status).toBe("stale");
    expect(after!.result).toMatchObject({ reason: "separation_of_duties" });
  });

  it("fails closed on a broken chain: refused at request time, and stale (nothing moves) at decide time", async () => {
    const { promptCommits } = await import("@regulait/db");
    const p = await createPrompt(owner, "launder-broken");
    const h1 = (await commit(owner, p, "one {{x}}", null)).json().hash;
    const h2 = (await commit(owner, p, "two {{x}}", h1)).json().hash;
    const h3 = (await commit(owner, p, "three {{x}}", h2)).json().hash;
    // a request made while the chain is whole
    const req = await k.req("PUT", `/v1/prompts/${p}/tags/prod`, owner.auth, { commitHash: h3, approverUserId: reviewer.id });
    expect(req.statusCode, req.body).toBe(202);
    // h2's parent no longer resolves: who wrote what came before cannot be read
    await k.db.update(promptCommits).set({ parentHash: "e".repeat(64) }).where(and(eq(promptCommits.promptId, p), eq(promptCommits.hash, h2)));
    const ok = await decide(reviewer, req.json().promotion.approvalId, "approved");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await tagOf(p, "prod")).toBeNull();
    const [after] = await k.db.select().from(promptPromotions).where(eq(promptPromotions.id, req.json().promotion.id));
    expect(after!.result).toMatchObject({ reason: "chain_unverifiable", chain: "chain_broken" });
    // and a new request over the broken chain is refused outright
    const again = await k.req("PUT", `/v1/prompts/${p}/tags/prod`, owner.auth, { commitHash: h3, approverUserId: reviewer.id });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error).toBe("promotion_chain_unverifiable");
  });
});

describe("prompt references", () => {
  it("<promptId>@tag resolves the prompt by id, never a later prompt of the same name; name@tag only a live, visible one", async () => {
    const name = `ref-${k.RUN}`;
    const r = await k.req("POST", "/v1/prompts", owner.auth, { name, visibility: "workspace" });
    expect(r.statusCode, r.body).toBe(201);
    const oldId = r.json().prompt.id as string;
    const o1 = (await commit(owner, oldId, "old {{x}}", null)).json().hash;
    expect((await k.req("PUT", `/v1/prompts/${oldId}/tags/staging`, owner.auth, { commitHash: o1 })).statusCode).toBe(200);
    const byId = await k.req("GET", `/v1/prompts/resolve?ref=${encodeURIComponent(`${oldId}@staging`)}`, outsider.auth);
    expect(byId.statusCode, byId.body).toBe(200);
    expect(byId.json()).toMatchObject({ promptId: oldId, tag: "staging", commit: { hash: o1 } });

    // archive, then someone else creates a prompt with the same name
    expect((await k.req("DELETE", `/v1/prompts/${oldId}`, owner.auth)).statusCode).toBe(200);
    const again = await k.req("POST", "/v1/prompts", coworker.auth, { name, visibility: "workspace" });
    expect(again.statusCode, again.body).toBe(201);
    const newId = again.json().prompt.id as string;
    const n1 = (await commit(coworker, newId, "new {{x}}", null)).json().hash;
    expect((await k.req("PUT", `/v1/prompts/${newId}/tags/staging`, coworker.auth, { commitHash: n1 })).statusCode).toBe(200);

    // the id form stops resolving with the archive; it never follows the name
    const stale = await k.req("GET", `/v1/prompts/resolve?ref=${encodeURIComponent(`${oldId}@staging`)}`, outsider.auth);
    expect(stale.statusCode).toBe(404);
    // the name form names the one live prompt of that name
    const byName = await k.req("GET", `/v1/prompts/resolve?ref=${encodeURIComponent(`${name}@staging`)}`, outsider.auth);
    expect(byName.json()).toMatchObject({ promptId: newId, commit: { hash: n1 } });

    // a private prompt resolves for nobody who may not see it, in either form
    const priv = await createPrompt(owner, "ref-private");
    const p1 = (await commit(owner, priv, "p {{x}}", null)).json().hash;
    await k.req("PUT", `/v1/prompts/${priv}/tags/staging`, owner.auth, { commitHash: p1 });
    expect((await k.req("GET", `/v1/prompts/resolve?ref=${encodeURIComponent(`${priv}@staging`)}`, outsider.auth)).statusCode).toBe(404);
    expect((await k.req("GET", `/v1/prompts/resolve?ref=${encodeURIComponent(`ref-private-${k.RUN}@staging`)}`, outsider.auth)).statusCode).toBe(404);
    expect((await k.req("GET", `/v1/prompts/resolve?ref=${encodeURIComponent(`${priv}@staging`)}`, owner.auth)).statusCode).toBe(200);

    // a name can never take the form of an id, so the two forms cannot collide
    const uuidName = await k.req("POST", "/v1/prompts", owner.auth, { name: crypto.randomUUID() });
    expect(uuidName.statusCode).toBe(400);
  });
});
