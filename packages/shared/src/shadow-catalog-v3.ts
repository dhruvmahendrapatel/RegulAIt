/**
 * ADR-0195 decision 15 — `SHADOW_AI_CATALOG_V3`, the compiled triage catalogue the repo scanner (SD1) reads.
 *
 * WHY A V3. V2 is pinned by count and hash (`shadow-catalog-v2.test.ts`) so that "matched X @ catalog v2" means the
 * same thing for ever (ADR-0083 §2). V3 = every v2 entry, unchanged and in order, plus the additions below. V3 is
 * deep-frozen and pinned the same way in `shadow-catalog-v3.test.ts`; a v4 is the only way to change it.
 *
 * WHAT IS NEW IN V3 (2026-11-14, lane L10; PENDING P35 follow-up and S17)
 *   - AI provider and AI-builder hosts from the PatronAI comparison (ADR-0259 §7): each one cross-checked against
 *     the pinned PatronAI data (Apache-2.0, licence re-checked 2026-11-14, no NOTICE file) and then confirmed at
 *     the vendor on the date in its `verified` field: API hosts against the vendor's documentation, and browser-only
 *     products (Bolt, Grok, Suno, Pika, NotebookLM, Flowise Cloud) against the product's own site, which is its own
 *     evidence that the host serves it. Candidates the vendor no longer
 *     documents (a shut-down service, a rebrand, a legacy host) were left out, and wildcards that would also match a
 *     vendor's marketing and docs sites (`*.pinecone.io`, `*.trychroma.com`) were narrowed to the API host.
 *     Generic hosting platforms (Vercel, Render, Railway, Fly) are not AI signals on their own and are left out.
 *   - S17: the GitHub Copilot hosts in v2 were re-checked against the Copilot allow-list reference on 2026-11-14 and
 *     still match it; v3 adds the Azure Web PubSub hosts that document Copilot cloud sessions in the browser.
 *
 * Nothing here mints a finding (ADR-0083 §3, ADR-0195 rule 5). NO REGEX FROM DATA: patterns are literal strings
 * with at most one `*`, the same rule v1 and v2 enforce.
 */
import { PATRONAI_SOURCE, SHADOW_AI_CATALOG_V2, type ShadowCatalogV2Entry } from "./shadow-catalog-v2.js";

export const SHADOW_AI_CATALOG_V3_VERSION = 3;

const REGULAIT = Object.freeze({ project: "regulait", commit: null, licence: "regulait" });
const on = "2026-11-14";
const doc = (url: string) => ({ url, checkedOn: on });

const deepFreeze = <T extends object>(o: T): T => {
  for (const v of Object.values(o)) if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v as object);
  return Object.freeze(o);
};

/** an endpoint cross-checked with PatronAI's data and confirmed at the vendor */
const P = (id: string, pattern: string, provider: string, notes: string, url: string): ShadowCatalogV2Entry => ({
  id,
  kind: "endpoint",
  pattern,
  provider,
  notes,
  source: PATRONAI_SOURCE,
  verified: doc(url),
});

const COPILOT_ALLOWLIST = "https://docs.github.com/en/copilot/reference/copilot-allowlist-reference";

/**
 * VERSION 3 — FROZEN 2026-11-14. v2's 180 entries first, unchanged, then the additions. Pinned by count and hash.
 */
export const SHADOW_AI_CATALOG_V3: ReadonlyArray<ShadowCatalogV2Entry> = deepFreeze([
  ...SHADOW_AI_CATALOG_V2,

  // --- model and inference APIs ---
  P("ep-ai21-api", "api.ai21.com", "ai21", "AI21 Labs (Jamba) API base host.", "https://docs.ai21.com/reference/jamba-1-6-api-ref"),
  P("ep-nvidia-nim-api", "integrate.api.nvidia.com", "nvidia", "NVIDIA API catalog: hosted NIM chat-completions base host.", "https://docs.api.nvidia.com/nim/reference/"),
  P("ep-beam-endpoints", "*.app.beam.cloud", "beam", "Beam Cloud deployed endpoints (<name>-<id>-v1.app.beam.cloud).", "https://docs.beam.cloud/v2/endpoint/overview"),
  P("ep-modal-web", "*.modal.run", "modal", "Modal web function URLs (<workspace>--<label>.modal.run). Custom domains are not covered.", "https://modal.com/docs/guide/webhook-urls"),
  P("ep-manus-api", "api.manus.ai", "manus", "Manus agent API host.", "https://open.manus.ai/docs/v2/introduction"),
  P("ep-v0-api", "v0.dev", "vercel-v0", "Vercel v0: the v0.dev host and its API hosts (api.v0.dev, api.enterprise.v0.dev).", "https://v0.app/docs/api/v1"),

  // --- vector databases, ML ops and data labelling ---
  P("ep-pinecone-api", "api.pinecone.io", "pinecone", "Pinecone control-plane API. Index data-plane hosts (<index>.svc.<env>.pinecone.io) are not covered: a wildcard would also match the vendor's own sites.", "https://docs.pinecone.io/reference/api/2025-10/control-plane/create_index"),
  P("ep-chroma-cloud", "api.trychroma.com", "chroma", "Chroma Cloud default client host. Regional hosts are not covered: a wildcard would also match the vendor's own sites.", "https://docs.trychroma.com/docs/run-chroma/clients"),
  P("ep-wandb-api", "api.wandb.ai", "wandb", "Weights & Biases multi-tenant cloud API: experiment data and LLM traces leaving the network.", "https://docs.wandb.ai/"),
  P("ep-scale-api", "api.scale.com", "scale-ai", "Scale AI data-labelling and evaluation API.", "https://api-reference.scale.com/docs/api-reference/authentication"),

  // --- workflow and agent builders ---
  P("ep-n8n-cloud", "app.n8n.cloud", "n8n", "n8n Cloud console and instances (<name>.app.n8n.cloud), which run AI agent workflows.", "https://docs.n8n.io/connect/n8n-api/authentication"),
  P("ep-dify-api", "api.dify.ai", "dify", "Dify Cloud application API base host.", "https://docs.dify.ai/en/api-reference/guides/get-started"),
  P("ep-flowise-cloud", "cloud.flowiseai.com", "flowise", "Flowise Cloud hosted agent builder. Browser usage, not an API integration.", "https://flowiseai.com/"),
  P("ep-sim-ai", "sim.ai", "sim", "Sim agent-workflow builder: the web app and its API (www.sim.ai/api).", "https://docs.sim.ai/api-reference/getting-started"),

  // --- consumer and builder web apps (browser usage, not API integrations) ---
  P("ep-google-ai-studio", "aistudio.google.com", "google", "Google AI Studio web app. Browser usage, not an API integration.", "https://ai.google.dev/gemini-api/docs/api-key"),
  P("ep-notebooklm", "notebooklm.google.com", "google", "NotebookLM web app: documents uploaded for AI summarisation. Browser usage.", "https://notebooklm.google.com/"),
  P("ep-google-opal", "opal.google", "google", "Google Opal AI mini-app builder. Browser usage.", "https://developers.google.com/opal"),
  P("ep-google-opal-com", "opal.google.com", "google", "Google Opal AI mini-app builder on its google.com host. Browser usage.", "https://developers.google.com/opal"),
  P("ep-v0-app", "v0.app", "vercel-v0", "Vercel v0 AI app builder web app. Browser usage.", "https://v0.app/docs/api/v1"),
  P("ep-manus-app", "manus.im", "manus", "Manus agent web app. Browser usage.", "https://open.manus.ai/docs/v2/introduction"),
  P("ep-bolt", "bolt.new", "bolt", "Bolt.new AI app builder. Browser usage.", "https://bolt.new/"),
  P("ep-grok-web", "grok.com", "xai", "xAI Grok consumer chat app (the API is api.x.ai, already in v1). Browser usage.", "https://grok.com/"),
  P("ep-suno", "suno.com", "suno", "Suno AI music generation web app. Browser usage.", "https://suno.com/"),
  P("ep-pika", "pika.art", "pika", "Pika AI video generation web app (create.pika.art). Browser usage.", "https://pika.art/"),

  // --- S17: GitHub Copilot cloud sessions (re-check of the v2 Copilot hosts, 2026-11-14) ---
  {
    id: "ep-github-copilot-cloud-session",
    kind: "endpoint",
    pattern: "production-copilot-host*.webpubsub.azure.com",
    provider: "github-copilot",
    notes: "WebSocket hosts Copilot on GitHub uses to stream cloud-session events (production-copilot-host[-region].webpubsub.azure.com).",
    source: REGULAIT,
    verified: doc(COPILOT_ALLOWLIST),
  },
]);
