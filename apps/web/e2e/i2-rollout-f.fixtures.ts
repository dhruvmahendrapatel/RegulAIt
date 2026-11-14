/**
 * I-2 rollout F: mocked gateways for the regulAIt-LLM and Webhooks pages (Cost consolidation reuses `mockOps` from
 * long-pages-ops.fixtures). Synthetic names only.
 */
import type { Page, Route } from "@playwright/test";
import { installBuilderMock } from "./builder-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
export const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ISO = "2026-10-12T10:00:00.000Z";
export const ERR = { status: 500, body: { error: "upstream_unavailable" } };

// ---------------------------------------------------------------- regulAIt-LLM

export const BACKENDS = {
  enabled: true,
  approvalThresholdUsd: 10,
  note: "Each backend states what it cannot do.",
  backends: [
    { kind: "local", requiresCredential: false, inProcess: true, methods: ["retrieval_index", "text_classifier"], producesQueryableArtifact: true, supportsCancel: true, summary: "Runs here.", limits: "IT DOES NOT FINE-TUNE A LANGUAGE MODEL", defaultBaseUrl: null, configured: true, configEnabled: true, hasCredential: false, baseUrl: null, lastTestError: null },
    { kind: "remote-example", requiresCredential: true, inProcess: false, methods: ["lora_sft"], producesQueryableArtifact: false, supportsCancel: true, summary: "Vendor compute.", limits: "Weights stay on the backend.", defaultBaseUrl: null, configured: false, configEnabled: false, hasCredential: false, baseUrl: null, lastTestError: null },
  ],
};
const DS = (n: number, name: string, verdict: string, jobCount: number) => ({
  id: U(800 + n), name, version: 1, note: null, format: "prompt_completion", rowCount: 2, charCount: 40, checksum: "sha256:x", piiVerdict: verdict, piiMode: "warn", scanFindings: { pii: verdict === "clean" ? [] : [{ category: "email", count: 1 }], guardrails: [] }, projectId: null, jobCount, frozen: jobCount > 0, createdAt: ISO,
});
export const DATASETS = [DS(0, "faq", "clean", 1), DS(1, "tickets", "flagged", 0)];
export const ARTIFACT = { id: U(820), jobId: U(810), name: "faq-index", method: "retrieval_index", baseModel: null, kind: "inline", location: null, metrics: { recallAt3: 0.9 }, agentId: null, modelCardId: null, queryable: true, payloadKind: null, payloadSummary: null, createdAt: ISO };
export const JOB = { id: U(810), name: "faq-index", datasetId: DATASETS[0]!.id, datasetName: "faq", datasetVersion: 1, backend: "local", method: "retrieval_index", baseModel: null, status: "succeeded", progress: 1, error: null, estimatedCostUsd: 0, costUsd: 0, projectId: null, approvalId: null, artifactId: ARTIFACT.id, createdAt: ISO, durationMs: 1200 };

export type Overrides = Record<string, { status: number; body: Json }>;

export async function mockLlm(page: Page, overrides: Overrides = {}) {
  await installBuilderMock(page, { isAdmin: true });
  await page.route(/\/v1\/llm\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const o = overrides[`${req.method()} ${p}`];
    if (o) return json(route, o.body, o.status);
    if (req.method() !== "GET") return json(route, {});
    if (p === "/v1/llm/backends") return json(route, BACKENDS);
    if (p === "/v1/llm/datasets") return json(route, { datasets: DATASETS, note: "" });
    if (p.startsWith("/v1/llm/datasets/")) {
      const d = DATASETS.find((x) => p.endsWith(x.id)) ?? DATASETS[0]!;
      return json(route, { dataset: d, rows: [{ id: "r1", idx: 0, input: "q", output: "a" }], versions: [d], jobs: [], frozen: d.frozen });
    }
    if (p === "/v1/llm/jobs") return json(route, { jobs: [JOB] });
    if (p === "/v1/llm/artifacts") return json(route, { artifacts: [ARTIFACT], note: "" });
    if (p === `/v1/llm/artifacts/${ARTIFACT.id}`) return json(route, { artifact: ARTIFACT, job: JOB, trainedOn: DATASETS[0], modelCard: null, agent: null });
    return json(route, {});
  });
}

// ---------------------------------------------------------------- Webhooks

export const WEBHOOK_EVENTS = {
  families: ["prompt"],
  events: [
    { name: "prompt.commit", family: "prompt", description: "A new commit was written to a prompt in the registry.", fields: [] },
    { name: "prompt.tag.moved", family: "prompt", description: "A prompt tag now points at a different commit.", fields: [] },
  ],
  signing: { scheme: "Standard Webhooks", headers: ["webhook-id", "webhook-timestamp", "webhook-signature"], note: "" },
};
export const SUB = { id: U(900), name: "release-notifier", url: "https://hooks.example.test/regulait", events: ["prompt.*"], active: true, allowPlaintextHttp: false, createdByUserId: null, secretRotatedAt: ISO, createdAt: ISO, updatedAt: ISO, lastDelivery: null, pendingDeliveries: 0, failedDeliveries: 0 };

export async function mockWebhooks(page: Page, opts: { subs?: Json[]; hosts?: string[]; overrides?: Overrides } = {}) {
  await installBuilderMock(page, { isAdmin: true });
  const st = { subs: [...(opts.subs ?? [])], posts: [] as Json[] };
  await page.route(/\/v1\/(webhooks|egress-allow-hosts)/, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const o = opts.overrides?.[`${req.method()} ${p}`];
    if (o) return json(route, o.body, o.status);
    if (p === "/v1/egress-allow-hosts") return json(route, { hosts: (opts.hosts ?? ["hooks.example.test"]).map((host, i) => ({ id: `h${i}`, host, allowPrivate: false, allowPlaintextHttp: false })) });
    if (p === "/v1/webhooks/events") return json(route, WEBHOOK_EVENTS);
    if (p === "/v1/webhooks" && req.method() === "GET") return json(route, { subscriptions: st.subs });
    if (p === "/v1/webhooks" && req.method() === "POST") {
      const body = req.postDataJSON();
      st.posts.push(body);
      const sub = { ...SUB, name: body.name, url: body.url, events: body.events };
      st.subs.push(sub);
      return json(route, { ...sub, secret: `whsec_${"A".repeat(43)}=` }, 201);
    }
    return json(route, {});
  });
  return st;
}
