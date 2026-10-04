/**
 * ADR-0172 — the agent builder's request vocabulary.
 *
 * The gateway parses every builder request with these, and the web half types
 * its calls against them, so the two sides of the API cannot disagree about a
 * limit (a name length, an instruction ceiling, a cadence) without one of them
 * failing to compile or to validate.
 */
import { z } from "zod";

export const BUILDER_SHARING_VALUES = ["private", "workspace", "people"] as const;
export const BUILDER_CONNECTION_FORMAT_VALUES = ["shared", "per_user"] as const;
export const BUILDER_CADENCE_VALUES = ["hourly", "daily", "weekdays", "weekly"] as const;
export const BUILDER_CHANNEL_PROVIDER_VALUES = ["slack", "teams", "outlook", "email"] as const;
export const BUILDER_THREAD_STATUS_VALUES = ["active", "needs_attention", "completed"] as const;

export type BuilderCadenceValue = (typeof BUILDER_CADENCE_VALUES)[number];

/**
 * The builder's resource ceilings, shared so the web can say them in copy.
 * Each is enforced by the gateway with a named 422 (never a silent drop).
 */
export const BUILDER_LIMITS = {
  /** schedules on one agent */
  schedulesPerAgent: 20,
  /** channel bindings on one agent */
  channelsPerAgent: 4,
  /** memory items on one agent (append-only; the owner removes old ones) */
  memoryPerAgent: 500,
  /** sub-agents one import may create */
  importSubagents: 10,
  /** the configured system prompt (instructions + pinned skills), UTF-8 bytes */
  systemPromptBytes: 48 * 1024,
  /** schedule runs per agent owner in one sweep pass (the rest stay due) */
  sweepRunsPerOwner: 10,
} as const;

/**
 * The avatar palette. Every fill carries WHITE initials at WCAG AA (>= 4.5:1),
 * which is why an agent's colour is one of these and nothing else. The web
 * mirrors this list as `AGENT_COLORS` (apps/web/src/views/builder/builderLogic.ts);
 * `builder-agents.test.ts` fails when the two drift.
 */
export const BUILDER_AGENT_COLORS = ["#2563eb", "#7c3aed", "#0e7490", "#047857", "#b45309", "#be185d", "#4338ca", "#0f766e"] as const;
export type BuilderAgentColor = (typeof BUILDER_AGENT_COLORS)[number];

/** a stable palette colour for a name (the default for new and seeded agents) */
export function builderColorFor(name: string): BuilderAgentColor {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BUILDER_AGENT_COLORS[h % BUILDER_AGENT_COLORS.length]!;
}

/** accepts any case, stores lower case, and only palette colours */
const paletteColor = z
  .string()
  .transform((c) => c.toLowerCase())
  .refine((c): c is BuilderAgentColor => (BUILDER_AGENT_COLORS as readonly string[]).includes(c), {
    message: `color must be one of ${BUILDER_AGENT_COLORS.join(", ")}`,
  });
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be #rrggbb");
const timeUtc = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "timeUtc must be HH:MM (UTC)");

export const builderCreateAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).optional(),
    modelAgentId: z.string().uuid().optional(),
    connectionFormat: z.enum(BUILDER_CONNECTION_FORMAT_VALUES),
    computerUse: z.boolean(),
    templateId: z.string().min(1).max(80).optional(),
  })
  .strict();
export type BuilderCreateAgent = z.infer<typeof builderCreateAgentSchema>;

export const builderUpdateAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    color: paletteColor.optional(),
    instructions: z.string().max(20_000).optional(),
    modelAgentId: z.string().uuid().optional(),
    sharing: z.enum(BUILDER_SHARING_VALUES).optional(),
    sharedUserIds: z.array(z.string().uuid()).max(200).optional(),
    monthlyLimitUsd: z.number().min(0.01).max(100_000).nullable().optional(),
    computerUse: z.boolean().optional(),
    /** the project this agent's spend bills to (null clears it) */
    projectId: z.string().uuid().nullable().optional(),
    /** accepted by the parser only so the route can refuse it with a named 409 */
    connectionFormat: z.enum(BUILDER_CONNECTION_FORMAT_VALUES).optional(),
  })
  .strict();
export type BuilderUpdateAgent = z.infer<typeof builderUpdateAgentSchema>;

export const builderToolInputSchema = z
  .object({
    kind: z.enum(["connector", "mcp_tool"]),
    refId: z.string().uuid(),
    requiresApproval: z.boolean(),
  })
  .strict();
export const builderSetToolsSchema = z.object({ tools: z.array(builderToolInputSchema).max(100) }).strict();

export const builderSetSubagentsSchema = z
  .object({
    subagents: z
      .array(
        z
          .object({
            childId: z.string().uuid(),
            name: z.string().trim().min(1).max(80),
            description: z.string().max(500).default(""),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export const builderSetSkillsSchema = z.object({ skillIds: z.array(z.string().uuid()).max(50) }).strict();

export const builderAddMemorySchema = z.object({ content: z.string().trim().min(1).max(2000) }).strict();

export const builderCreateScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    cadence: z.enum(BUILDER_CADENCE_VALUES),
    timeUtc,
    prompt: z.string().trim().min(1).max(4000),
    enabled: z.boolean(),
  })
  .strict();
export const builderUpdateScheduleSchema = builderCreateScheduleSchema.partial().strict();

export const builderCreateChannelSchema = z
  .object({
    provider: z.enum(BUILDER_CHANNEL_PROVIDER_VALUES),
    chatopsConnectionId: z.string().uuid().optional(),
  })
  .strict();

export const builderChatSchema = z
  .object({
    threadId: z.string().uuid().optional(),
    message: z.string().trim().min(1).max(8000),
  })
  .strict();

export const builderThreadListQuerySchema = z.object({
  status: z.enum(["needs_attention", "completed", "all"]).default("all"),
  agentId: z.string().uuid().optional(),
});

export const builderUpdateThreadSchema = z.object({ status: z.enum(BUILDER_THREAD_STATUS_VALUES) }).strict();

export const builderCreateSkillSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).default(""),
    body: z.string().max(20_000),
    visibility: z.enum(["private", "workspace"]),
  })
  .strict();
export const builderUpdateSkillSchema = builderCreateSkillSchema.partial().strict();
export const builderImportSkillSchema = z.object({ markdown: z.string().min(1).max(40_000) }).strict();

export const builderUsageQuerySchema = z.object({
  days: z.coerce.number().refine((d) => d === 7 || d === 30, "days must be 7 or 30").default(30),
});

/** the portable bundle `GET …/export` produces and `POST /builder/agents/import`
 * accepts. No ids and no owners: tools are named (connector name, or MCP
 * server + tool name) and re-resolved — and re-entitled — on import. */
export const builderBundleSchema = z
  .object({
    version: z.literal(1),
    agent: z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().max(500).default(""),
      color: hexColor.optional(),
      instructions: z.string().max(20_000).default(""),
      connectionFormat: z.enum(BUILDER_CONNECTION_FORMAT_VALUES).default("shared"),
      computerUse: z.boolean().default(false),
      monthlyLimitUsd: z.number().min(0.01).max(100_000).nullable().default(null),
      model: z
        .object({ name: z.string().max(200), provider: z.string().max(80), model: z.string().max(200).nullable() })
        .nullable()
        .default(null),
      tools: z
        .array(
          z.object({
            kind: z.enum(["connector", "mcp_tool"]),
            name: z.string().min(1).max(200),
            server: z.string().max(200).nullable().default(null),
            requiresApproval: z.boolean().default(false),
          }),
        )
        .max(100)
        .default([]),
      subagents: z
        .array(z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).default("") }))
        .max(20)
        .default([]),
      skills: z.array(z.string().min(1).max(120)).max(50).default([]),
      schedules: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(120),
            cadence: z.enum(BUILDER_CADENCE_VALUES),
            timeUtc,
            prompt: z.string().trim().min(1).max(4000),
          }),
        )
        .max(20)
        .default([]),
    }),
    skills: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(120),
          description: z.string().max(1000).default(""),
          body: z.string().max(20_000).default(""),
        }),
      )
      .max(50)
      .default([]),
  })
  .strict();
export type BuilderBundle = z.infer<typeof builderBundleSchema>;
export const builderImportAgentSchema = z.object({ bundle: builderBundleSchema }).strict();

/**
 * Parse a SKILL.md: YAML-ish frontmatter between `---` fences carrying `name`
 * and `description` (plain `key: value` lines; surrounding quotes stripped).
 * The body is everything after the closing fence. Returns null when the
 * frontmatter is missing or names no skill.
 */
export function parseSkillMarkdown(markdown: string): { name: string; description: string; body: string } | null {
  const text = markdown.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fields[kv[1]!.toLowerCase()] = v;
  }
  const name = (fields["name"] ?? "").trim();
  if (!name) return null;
  return { name: name.slice(0, 120), description: (fields["description"] ?? "").slice(0, 1000), body: m[2]!.trim() };
}

/**
 * The next time a schedule is due strictly after `after`, in UTC.
 *  - hourly: every hour at the given minute (the hour part is ignored)
 *  - daily: every day at HH:MM
 *  - weekdays: Monday–Friday at HH:MM
 *  - weekly: every 7 days at HH:MM, on the weekday of `anchor` (the creation day)
 */
export function nextScheduleRun(
  cadence: BuilderCadenceValue,
  timeUtcValue: string,
  after: Date,
  anchor: Date = after,
): Date {
  const [hh, mm] = timeUtcValue.split(":").map((s) => Number(s)) as [number, number];
  if (cadence === "hourly") {
    const d = new Date(after.getTime());
    d.setUTCSeconds(0, 0);
    d.setUTCMinutes(mm);
    if (d.getTime() <= after.getTime()) d.setUTCHours(d.getUTCHours() + 1);
    return d;
  }
  const d = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), hh, mm, 0, 0));
  for (let i = 0; i < 15; i++) {
    if (d.getTime() > after.getTime()) {
      const dow = d.getUTCDay();
      if (cadence === "daily") return d;
      if (cadence === "weekdays" && dow >= 1 && dow <= 5) return d;
      if (cadence === "weekly" && dow === anchor.getUTCDay()) return d;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}
