/**
 * ADR-0339 slice 2 — AUTHOR VS RUNNER, AND NON-HUMAN IDENTITY LINKS: the vocabulary (pure).
 *
 * - AUTHOR: who built the agent, recorded once at creation and never rewritten. `principal` is the signed-in person
 *   whose request created a registry agent (read from the request's row-level-security principal inside the insert's
 *   own transaction); `builder_owner` is the person who created a builder agent (its owner at creation); `vendor_record`
 *   is an imported agent's vendor-side creator (a pseudonym, from the import); `unknown` is every agent that existed
 *   before this was recorded and any write with no principal. An author is never guessed.
 * - RUNNER: computed on read (the workload identity it runs as, the people seen invoking it, how a builder agent's
 *   connections resolve), never stored.
 * - NON-HUMAN IDENTITY LINKS: an agent's cloud service account, vendor agent identity or OAuth client. Vendor-neutral
 *   (a closed provider list with `other`), read-only toward the vendor (a link is a record, it calls nothing), and
 *   default-deny: a link is `staged` until a second admin confirms it with an `identity_manage` step-up. A link, staged
 *   or confirmed, confers nothing.
 *
 * Open-source check (ADR-0176): none fits; identifier shapes are checked with bounded regular expressions.
 */
import { z } from "zod";

export const AGENT_AUTHOR_SOURCES = ["principal", "builder_owner", "vendor_record", "unknown"] as const;
export type AgentAuthorSource = (typeof AGENT_AUTHOR_SOURCES)[number];

export const AGENT_NHI_KINDS = ["cloud_service_account", "vendor_agent_identity", "oauth_client"] as const;
export type AgentNhiKind = (typeof AGENT_NHI_KINDS)[number];

export const AGENT_NHI_PROVIDERS = ["aws", "azure", "gcp", "entra", "okta", "other"] as const;
export type AgentNhiProvider = (typeof AGENT_NHI_PROVIDERS)[number];

export const AGENT_NHI_LINK_STATUSES = ["staged", "confirmed", "rejected"] as const;
export type AgentNhiLinkStatus = (typeof AGENT_NHI_LINK_STATUSES)[number];

export const AGENT_NHI_LINK_SOURCES = ["admin", "importer"] as const;
export type AgentNhiLinkSource = (typeof AGENT_NHI_LINK_SOURCES)[number];

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** the identifier shapes each provider issues; `other` is any bounded, printable token */
export const AGENT_NHI_ID_PATTERNS: Readonly<Record<AgentNhiProvider, readonly RegExp[]>> = Object.freeze({
  // an ARN: an IAM role or user, or any service resource such as an AgentCore runtime
  aws: [/^arn:aws(-[a-z]+)*:[a-z0-9-]{1,64}:[a-z0-9-]{0,32}:\d{12}:[A-Za-z0-9+=,.@_/:-]{1,512}$/],
  // a managed identity or service principal object id, or a full resource id
  azure: [GUID, /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/[A-Za-z0-9./_-]{1,400}$/],
  // a service account email or a resource name
  gcp: [/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/, /^projects\/[a-z0-9-]{1,63}\/[A-Za-z0-9._/-]{1,400}$/],
  // an Entra (Agent ID, service principal or app) object id
  entra: [GUID],
  // an Okta client or service app id
  okta: [/^0o[A-Za-z0-9]{18}$/],
  other: [/^[\x21-\x7e]{1,256}$/],
});

export function validNhiExternalId(provider: AgentNhiProvider, externalId: string): boolean {
  return externalId.length <= 1024 && AGENT_NHI_ID_PATTERNS[provider].some((re) => re.test(externalId));
}

export const stageAgentNhiLinkSchema = z
  .object({
    kind: z.enum(AGENT_NHI_KINDS),
    provider: z.enum(AGENT_NHI_PROVIDERS),
    externalId: z.string().min(1).max(1024),
    note: z.string().max(500).optional(),
  })
  .strict()
  .refine((b) => validNhiExternalId(b.provider, b.externalId), {
    message: "externalId is not an identifier this provider issues",
    path: ["externalId"],
  });
export type StageAgentNhiLink = z.infer<typeof stageAgentNhiLinkSchema>;

export const decideAgentNhiLinkSchema = z
  .object({ decision: z.enum(["confirmed", "rejected"]), note: z.string().max(500).optional() })
  .strict();
export type DecideAgentNhiLink = z.infer<typeof decideAgentNhiLinkSchema>;
