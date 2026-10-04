/**
 * ADR-0175 A7 — THE NON-HUMAN CREDENTIAL INVENTORY, pure half.
 *
 * The gateway reads every stored credential (credential-inventory.ts) into a
 * `CredentialRecord`; this file decides what each record's flags are, and
 * describes each credential type: its label, where it is managed, whether any
 * last-used signal exists for it, and what "over-scoped" means for it.
 *
 * WHAT A RECORD NEVER CARRIES: secret material, ciphertext, hashes or any
 * prefix of them. The record is built from metadata columns only.
 *
 * THE FLAGS, AND WHY EACH IS CONSERVATIVE
 *  - `never_expires`: only for credentials THIS platform issues and could give
 *    a lifetime (API keys, virtual keys, SCIM tokens). A third-party secret we
 *    merely hold (a provider key, a git token) may well expire upstream; we do
 *    not know, so its expiry is "not tracked", never "never".
 *  - `past_expiry`: an expiry we track has passed and nobody revoked the
 *    credential. It no longer authenticates, but it is still on the books.
 *  - `unused`: the credential is older than N days (org setting, default 90)
 *    and its last use, where a signal exists, is older than N days or absent.
 *    A type with no last-used signal is NEVER flagged unused: unobservable is
 *    said, not counted as unused.
 *  - `owner_deactivated`: the owning person (or, for an integration credential
 *    with no owner, the person who created it) is deactivated.
 *  - `over_scoped`: defined per type below, and only where the stored scope
 *    makes it decidable. Every other type is never flagged over-scoped.
 */

export const CREDENTIAL_FLAGS = [
  "never_expires",
  "past_expiry",
  "unused",
  "owner_deactivated",
  "over_scoped",
] as const;
export type CredentialFlag = (typeof CREDENTIAL_FLAGS)[number];

export const CREDENTIAL_FLAG_LABELS: Record<CredentialFlag, string> = {
  never_expires: "Never expires",
  past_expiry: "Past expiry",
  unused: "Unused",
  owner_deactivated: "Owner deactivated",
  over_scoped: "Over-scoped",
};

/** where a last-used date comes from */
export type LastUsedSignal =
  /** the credential row's own `last_used_at`, written when it authenticates */
  | "recorded"
  /** derived from a ledger that records each use of exactly this credential */
  | "ledger"
  /** nothing records when this credential is used */
  | "none";

export interface CredentialTypeInfo {
  label: string;
  /** the admin page where this credential is created, rotated or removed */
  manageAt: string;
  lastUsed: LastUsedSignal;
  /** where the last-used date comes from, or why there is none */
  lastUsedNote: string;
  /** true when this platform issues the credential and could give it a lifetime */
  issuedHere: boolean;
  /** what "over-scoped" means for this type, or null when it is never flagged */
  overScoped: string | null;
}

export const CREDENTIAL_TYPES = {
  api_key: {
    label: "API key",
    manageAt: "/admin/users",
    lastUsed: "recorded",
    lastUsedNote: "the key's last_used_at, written when it authenticates",
    issuedHere: true,
    overScoped:
      "its owner is an administrator, so the key carries administrator power on every admin route",
  },
  virtual_key: {
    label: "Virtual key",
    manageAt: "/admin/virtual-keys",
    lastUsed: "recorded",
    lastUsedNote: "the key's last_used_at, written when it authenticates",
    issuedHere: true,
    overScoped:
      "a dispatch key with no model restriction and no budget, so it is no narrower than its owner",
  },
  scim_token: {
    label: "SCIM provisioning token",
    manageAt: "/admin/provisioning",
    lastUsed: "recorded",
    lastUsedNote: "the token's last_used_at, written when it authenticates",
    issuedHere: true,
    overScoped: null,
  },
  model_credential: {
    label: "Model provider key (platform)",
    manageAt: "/admin/model-credentials",
    lastUsed: "none",
    lastUsedNote:
      "the usage ledger does not record which credential in the resolution chain (own key, platform key, environment) served a call",
    issuedHere: false,
    overScoped: null,
  },
  user_model_credential: {
    label: "Model provider key (personal)",
    manageAt: "/admin/users",
    lastUsed: "none",
    lastUsedNote:
      "the usage ledger does not record which credential in the resolution chain served a call",
    issuedHere: false,
    overScoped: null,
  },
  custom_provider_key: {
    label: "Custom LLM provider key",
    manageAt: "/admin/custom-providers",
    lastUsed: "ledger",
    lastUsedNote: "the latest usage-ledger call served by an agent bound to this provider",
    issuedHere: false,
    overScoped: null,
  },
  external_scorer_key: {
    label: "External scorer secret",
    manageAt: "/admin/external-scorers",
    lastUsed: "none",
    lastUsedNote: "no ledger records a scorer call; a connection test is not a use",
    issuedHere: false,
    overScoped: null,
  },
  connector_credential: {
    label: "Connector credential",
    manageAt: "/admin/connectors",
    lastUsed: "ledger",
    lastUsedNote: "the latest governed call of this connector in the usage ledger",
    issuedHere: false,
    overScoped: null,
  },
  git_token: {
    label: "Git provider token",
    manageAt: "/admin/git-connections",
    lastUsed: "none",
    lastUsedNote: "git operations are not recorded per connection",
    issuedHere: false,
    overScoped: null,
  },
  pm_token: {
    label: "PM tool token",
    manageAt: "/admin/pm-connections",
    lastUsed: "none",
    lastUsedNote: "PM sync calls are not recorded per connection",
    issuedHere: false,
    overScoped: null,
  },
  pm_webhook_secret: {
    label: "PM webhook secret",
    manageAt: "/admin/pm-connections",
    lastUsed: "none",
    lastUsedNote: "verified webhook deliveries are not recorded per connection",
    issuedHere: false,
    overScoped: null,
  },
  deploy_credential: {
    label: "Deploy-target credential",
    manageAt: "/admin/deploy-targets",
    lastUsed: "none",
    lastUsedNote: "deploys name their target by name in workflow stages; no per-target use is recorded",
    issuedHere: false,
    overScoped: null,
  },
  deploy_role: {
    label: "Deploy-target role",
    manageAt: "/admin/deploy-targets",
    lastUsed: "none",
    lastUsedNote: "deploys name their target by name in workflow stages; no per-target use is recorded",
    issuedHere: false,
    overScoped: null,
  },
  chatops_signing_secret: {
    label: "ChatOps signing secret",
    manageAt: "/admin/chatops",
    lastUsed: "ledger",
    lastUsedNote: "the latest signed approval interaction received on this connection",
    issuedHere: false,
    overScoped: null,
  },
  oidc_client_secret: {
    label: "OIDC client secret",
    manageAt: "/admin/sso",
    lastUsed: "none",
    lastUsedNote: "sign-ins are not recorded per provider",
    issuedHere: false,
    overScoped: null,
  },
  saml_sp_key: {
    label: "SAML SP private key",
    manageAt: "/admin/sso",
    lastUsed: "none",
    lastUsedNote: "sign-ins are not recorded per provider",
    issuedHere: false,
    overScoped: null,
  },
  training_backend_key: {
    label: "Training backend key",
    manageAt: "/admin/regulait-llm",
    lastUsed: "none",
    lastUsedNote: "training jobs are not linked to the credential they used",
    issuedHere: false,
    overScoped: null,
  },
  otlp_headers: {
    label: "Tracing export headers",
    manageAt: "/admin/traces",
    lastUsed: "none",
    lastUsedNote: "trace exports are not recorded",
    issuedHere: false,
    overScoped: null,
  },
} as const satisfies Record<string, CredentialTypeInfo>;
export type CredentialType = keyof typeof CREDENTIAL_TYPES;
export const CREDENTIAL_TYPE_IDS = Object.keys(CREDENTIAL_TYPES) as CredentialType[];

/**
 * Credentials this deployment holds OUTSIDE the database, which the inventory
 * therefore cannot list. Said on the page so absence is never read as "none".
 */
export const CREDENTIALS_NOT_STORED: ReadonlyArray<{ what: string; why: string }> = [
  {
    what: "MCP server upstream auth",
    why:
      "MCP servers are registered by URL with no stored upstream credential (the egress guard refuses credentials in a URL's user-info); callers reach them with API or virtual keys, which are listed",
  },
  {
    what: "Export signing key",
    why: "held in a file named by the deployment's environment, never in the database",
  },
  {
    what: "Environment provider keys",
    why: "the platform fallback provider keys are environment variables on the gateway host",
  },
];

export interface CredentialRecord {
  /** `<type>:<row id>` — stable, and the monitor's subject */
  id: string;
  type: CredentialType;
  name: string;
  ownerUserId: string | null;
  /** `owner` = the person whose entitlements the credential carries;
   * `creator` = the person who registered an integration credential */
  ownerKind: "owner" | "creator" | null;
  ownerDisabled: boolean;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** when the secret was last set; null = not recorded (see rotationNote) */
  secretSetAt: string | null;
  /** true when the scope makes this credential over-scoped by its type's rule */
  overScoped: boolean;
}

export interface CredentialFlagResult {
  flags: CredentialFlag[];
  reasons: Partial<Record<CredentialFlag, string>>;
}

const DAY = 86_400_000;

export function credentialFlags(rec: CredentialRecord, now: Date, unusedDays: number): CredentialFlagResult {
  const info: CredentialTypeInfo = CREDENTIAL_TYPES[rec.type];
  const flags: CredentialFlag[] = [];
  const reasons: Partial<Record<CredentialFlag, string>> = {};
  if (rec.revokedAt) return { flags, reasons };
  const t = now.getTime();
  if (info.issuedHere && rec.expiresAt === null) {
    flags.push("never_expires");
    reasons.never_expires = "no expiry is set, so it authenticates until someone revokes it";
  }
  if (rec.expiresAt && Date.parse(rec.expiresAt) <= t) {
    flags.push("past_expiry");
    reasons.past_expiry = `expired ${rec.expiresAt.slice(0, 10)} and was never revoked`;
  }
  if (info.lastUsed !== "none") {
    const old = t - Date.parse(rec.createdAt) > unusedDays * DAY;
    const last = rec.lastUsedAt ? Date.parse(rec.lastUsedAt) : null;
    if (old && (last === null || t - last > unusedDays * DAY)) {
      flags.push("unused");
      reasons.unused =
        last === null
          ? `never used in the ${Math.floor((t - Date.parse(rec.createdAt)) / DAY)} days since it was created`
          : `not used for ${Math.floor((t - last) / DAY)} days (threshold ${unusedDays})`;
    }
  }
  if (rec.ownerDisabled) {
    flags.push("owner_deactivated");
    reasons.owner_deactivated =
      rec.ownerKind === "creator" ? "the person who created it is deactivated" : "its owner is deactivated";
  }
  if (rec.overScoped && info.overScoped) {
    flags.push("over_scoped");
    reasons.over_scoped = info.overScoped;
  }
  return { flags, reasons };
}

/** days since the secret was last set, or since creation when no set date is recorded */
export function rotationAgeDays(rec: CredentialRecord, now: Date): number {
  const from = Date.parse(rec.secretSetAt ?? rec.createdAt);
  return Math.max(0, Math.floor((now.getTime() - from) / DAY));
}
