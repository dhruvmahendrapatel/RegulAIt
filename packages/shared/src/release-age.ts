/**
 * ADR-0175 A5 — RELEASE-AGE COOLDOWN: the pure half.
 *
 * A supply-chain compromise is usually caught by somebody within days of the
 * bad release. An org that waits a few days before using anything new lets
 * that happen to someone else first. `org_settings.min_release_age_days`
 * (0 = off, the default; 7 recommended) keeps four kinds of thing in
 * quarantine until they are that old AND admitted:
 *
 *   - a newly registered MCP server (age from registration);
 *   - a changed manifest on an admitted MCP server (age from the first time
 *     this deployment saw that exact manifest digest);
 *   - a federated-registry import (age from the first time the registry sweep
 *     saw that exact entry version);
 *   - a new version of a builder skill (age from the first time this
 *     deployment saw that exact body digest).
 *
 * AGE IS OUR OWN CLOCK. It is always the time since THIS deployment first saw
 * the exact digest, never a date a publisher claims: a publish date is the
 * attacker's to set.
 *
 * An admin may override the cooldown for ONE item (one subject at one digest)
 * with a reason, audited. A changed digest is a new release and starts its own
 * clock; the override does not carry over.
 */
import { z } from "zod";

/** the setting's recommended value, shown next to the control */
export const RELEASE_AGE_RECOMMENDED_DAYS = 7;
export const RELEASE_AGE_MAX_DAYS = 365;

export const RELEASE_AGE_KINDS = ["mcp_server", "skill"] as const;
export type ReleaseAgeKind = (typeof RELEASE_AGE_KINDS)[number];

const DAY_MS = 86_400_000;

export interface ReleaseAgeStatus {
  /** true while the cooldown applies (on, too young, not overridden) */
  quarantined: boolean;
  /** whole days since first seen (floored) */
  ageDays: number;
  /** when it leaves quarantine; null when the cooldown is off */
  readyAt: string | null;
  overridden: boolean;
}

/** One item's cooldown status. Pure: the caller supplies the clock. */
export function releaseAgeStatus(args: {
  minDays: number;
  firstSeenAt: Date;
  now: Date;
  overridden: boolean;
}): ReleaseAgeStatus {
  const ageMs = Math.max(0, args.now.getTime() - args.firstSeenAt.getTime());
  const ageDays = Math.floor(ageMs / DAY_MS);
  if (args.minDays <= 0) return { quarantined: false, ageDays, readyAt: null, overridden: args.overridden };
  const readyAt = new Date(args.firstSeenAt.getTime() + args.minDays * DAY_MS);
  return {
    quarantined: !args.overridden && args.now.getTime() < readyAt.getTime(),
    ageDays,
    readyAt: readyAt.toISOString(),
    overridden: args.overridden,
  };
}

/** `POST /v1/release-quarantine/override` — admin, one item, reason required */
export const releaseOverrideSchema = z
  .object({
    kind: z.enum(RELEASE_AGE_KINDS),
    id: z.string().uuid(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ReleaseOverride = z.infer<typeof releaseOverrideSchema>;

/** `POST /v1/admission/skills/:id/admit` and the visibility decision */
export const admitSkillSchema = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
export const skillVisibilityDecisionSchema = z
  .object({ decision: z.enum(["approve", "deny"]), reason: z.string().trim().max(2000).optional() })
  .strict();
