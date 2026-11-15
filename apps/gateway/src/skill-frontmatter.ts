/**
 * ADR-0242 §7.3 (lane L4) — SKILL.md FRONTMATTER VALIDATION AT IMPORT.
 *
 * `POST /v1/builder/skills/import` takes a SKILL.md written outside the product. Before this, a lenient line parser
 * took any `key: value` lines, so a malformed or oversized frontmatter was imported with whatever it happened to
 * yield. Now the import follows the Agent Skills format strictly and refuses anything else (ADR-0180: secure by
 * default; nothing relaxes it):
 *
 *   - the file starts with a `---` fence and the frontmatter closes with another within
 *     SKILL_FRONTMATTER_MAX_BYTES bytes (an oversized or unclosed block is refused, never truncated);
 *   - the frontmatter is YAML, parsed by js-yaml 4.3.2 (MIT, already in the lockfile; ADR-0176) with its CORE
 *     schema: no custom tags, duplicate keys are an error, and the result must be one mapping;
 *   - only the format's fields are allowed: `name` (1–64 lowercase letters, digits and single hyphens, neither
 *     first nor last), `description` (1–1024 characters, required), and the optional `license`, `compatibility`
 *     (≤ 500), `metadata` (string to string, ≤ 32 entries) and `allowed-tools`. An unknown field is refused;
 *   - the body is at most SKILL_BODY_MAX_CHARS characters (the stored body's cap), checked before anything else
 *     reads it;
 *   - the progressive-loading layout: the body (the level-2 instructions) is at most SKILL_BODY_MAX_LINES lines,
 *     and every relative file it points at stays inside the skill (no absolute path, no `..`, no backslash, no
 *     `file:` URL). Bundled files are not accepted yet (ADR-0242 Context), so a reference is checked for shape only.
 *
 * The content scan (ADR-0175 A6) and the engine scan (ADR-0242) still run on the stored skill; this module only
 * decides whether the file is a well-formed SKILL.md. Refusals carry fixed text, never the file's own strings.
 */
import { CORE_SCHEMA, load } from "js-yaml";
import { z } from "zod";

export const SKILL_FRONTMATTER_MAX_BYTES = 8 * 1024;
export const SKILL_BODY_MAX_LINES = 500;
/** the stored body's own cap (builderCreateSkillSchema), checked here with the import's other limits */
export const SKILL_BODY_MAX_CHARS = 20_000;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** one line of text: no line breaks, tabs or other control characters (surrounding whitespace, e.g. the newline a
 * YAML `>` block ends with, is trimmed first) — these fields are shown on one line */
const oneLine = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => v.trim().length > 0, "must not be empty")
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v.trim()), "must be one line with no control characters");

const frontmatterSchema = z
  .object({
    name: z.string().min(1).max(64).regex(NAME, "lowercase letters, digits and single hyphens, neither first nor last"),
    description: oneLine(1024),
    license: oneLine(200).optional(),
    compatibility: oneLine(500).optional(),
    metadata: z
      .record(z.string().min(1).max(64), z.string().max(1024))
      .refine((m) => Object.keys(m).length <= 32, "at most 32 entries")
      .optional(),
    "allowed-tools": oneLine(1024).optional(),
  })
  .strict();

export type SkillMarkdownError =
  | "skill_frontmatter_missing"
  | "skill_frontmatter_too_large"
  | "skill_frontmatter_invalid"
  | "skill_layout_invalid"
  | "skill_body_too_long";

export type SkillMarkdownResult =
  | { ok: true; skill: { name: string; description: string; body: string } }
  | { ok: false; error: SkillMarkdownError; detail: string };

const refuse = (error: SkillMarkdownError, detail: string): SkillMarkdownResult => ({ ok: false, error, detail });

/** markdown link and image targets: `](target)` and `](<target>)` */
const LINK_TARGET = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

function referenceProblem(target: string): string | null {
  if (/^(?:https?|mailto):/i.test(target) || target.startsWith("#")) return null;
  if (/^file:/i.test(target)) return "a file: URL";
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // another scheme is a link, not a file of the skill
  if (target.startsWith("/") || target.startsWith("~")) return "an absolute path";
  if (target.includes("\\")) return "a backslash path";
  const path = target.split(/[?#]/, 1)[0]!;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return "a malformed path";
  }
  if (decoded.split("/").some((seg) => seg === "..")) return "a path that leaves the skill (..)";
  return null;
}

/**
 * Validate one SKILL.md. On success, the skill's name, description and body (the text after the closing fence,
 * trimmed) are returned for the normal save path.
 */
export function validateSkillMarkdown(markdown: string): SkillMarkdownResult {
  const text = markdown.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return refuse("skill_frontmatter_missing", "a SKILL.md starts with a --- block that names the skill (name: …) and describes it (description: …)");
  }
  const fence = /\n---(?:\n|$)/g;
  fence.lastIndex = 3;
  const close = fence.exec(text)?.index ?? -1;
  const frontmatter = close === -1 ? null : text.slice(4, close + 1);
  if (frontmatter !== null && Buffer.byteLength(frontmatter, "utf8") > SKILL_FRONTMATTER_MAX_BYTES) {
    return refuse("skill_frontmatter_too_large", `the frontmatter is larger than ${SKILL_FRONTMATTER_MAX_BYTES} bytes`);
  }
  if (frontmatter === null) {
    return Buffer.byteLength(text, "utf8") > SKILL_FRONTMATTER_MAX_BYTES + 8
      ? refuse("skill_frontmatter_too_large", `the frontmatter does not close within ${SKILL_FRONTMATTER_MAX_BYTES} bytes`)
      : refuse("skill_frontmatter_missing", "the frontmatter's --- block is not closed");
  }

  let parsed: unknown;
  try {
    parsed = load(frontmatter, { schema: CORE_SCHEMA, json: false });
  } catch {
    return refuse("skill_frontmatter_invalid", "the frontmatter is not valid YAML (or repeats a key)");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse("skill_frontmatter_invalid", "the frontmatter must be one mapping of fields");
  }
  const fields = frontmatterSchema.safeParse(parsed);
  if (!fields.success) {
    // fixed text: the field names come from the format, never the file
    const issue = fields.error.issues[0]!;
    const field = issue.code === "unrecognized_keys" ? null : String(issue.path[0] ?? "");
    const known = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
    return refuse(
      "skill_frontmatter_invalid",
      issue.code === "unrecognized_keys"
        ? `the frontmatter has a field the SKILL.md format does not define (allowed: ${known.join(", ")})`
        : field && known.includes(field)
          ? `the frontmatter's '${field}' field is invalid: ${field === "name" ? "1–64 lowercase letters, digits and single hyphens, neither first nor last" : field === "metadata" ? "a mapping of at most 32 short string keys to string values" : "a non-empty single line within its length limit"}`
          : "the frontmatter is invalid",
    );
  }

  const body = text.slice(close + 4).replace(/^\n/, "").trim();
  if (body.length > SKILL_BODY_MAX_CHARS) {
    return refuse("skill_body_too_long", `the SKILL.md body is longer than ${SKILL_BODY_MAX_CHARS} characters`);
  }
  if (body.split("\n").length > SKILL_BODY_MAX_LINES) {
    return refuse("skill_layout_invalid", `the SKILL.md body is longer than ${SKILL_BODY_MAX_LINES} lines; move detail into referenced files`);
  }
  for (const m of body.matchAll(LINK_TARGET)) {
    const problem = referenceProblem(m[1]!);
    if (problem) return refuse("skill_layout_invalid", `the SKILL.md body references ${problem}; a skill's files are relative paths inside the skill`);
  }
  return { ok: true, skill: { name: fields.data.name, description: fields.data.description.trim(), body } };
}
