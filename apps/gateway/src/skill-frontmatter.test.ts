/**
 * ADR-0242 §7.3 (lane L4): the strict SKILL.md frontmatter and layout check at import. Pure: no database.
 */
import { describe, expect, it } from "vitest";
import { SKILL_BODY_MAX_CHARS, SKILL_BODY_MAX_LINES, SKILL_FRONTMATTER_MAX_BYTES, validateSkillMarkdown } from "./skill-frontmatter.js";

const md = (front: string, body = "# Title\n\nDo the thing.\n") => `---\n${front}\n---\n${body}`;
const errorOf = (text: string) => {
  const r = validateSkillMarkdown(text);
  return r.ok ? null : r.error;
};

describe("validateSkillMarkdown", () => {
  it("accepts the format's fields and returns name, description and body", () => {
    const r = validateSkillMarkdown(
      md(
        [
          "name: pdf-forms",
          'description: "Fill PDF forms. Use when the user asks to fill a form."',
          "license: Apache-2.0",
          "compatibility: needs python3",
          "metadata:",
          "  author: example",
          '  version: "1.0"',
          "allowed-tools: Read Bash",
        ].join("\n"),
        "# PDF forms\n\nSee [the reference](references/REFERENCE.md) and [docs](https://example.com/x).\n",
      ),
    );
    expect(r).toEqual({
      ok: true,
      skill: { name: "pdf-forms", description: "Fill PDF forms. Use when the user asks to fill a form.", body: "# PDF forms\n\nSee [the reference](references/REFERENCE.md) and [docs](https://example.com/x)." },
    });
  });

  it("accepts CRLF line endings, a BOM and an empty body", () => {
    expect(validateSkillMarkdown("﻿---\r\nname: a\r\ndescription: d\r\n---\r\n")).toMatchObject({ ok: true, skill: { name: "a", body: "" } });
    expect(validateSkillMarkdown("---\nname: a\ndescription: d\n---")).toMatchObject({ ok: true });
  });

  it("refuses a file with no frontmatter, or one never closed", () => {
    expect(errorOf("# no frontmatter")).toBe("skill_frontmatter_missing");
    expect(errorOf("---\nname: a\ndescription: d\n")).toBe("skill_frontmatter_missing");
    expect(errorOf("---\nname: a\n---x\ndescription: d\n")).toBe("skill_frontmatter_missing");
  });

  it("refuses an oversized frontmatter, closed or not, without truncating it", () => {
    const big = `description: ${"x".repeat(SKILL_FRONTMATTER_MAX_BYTES)}`;
    expect(errorOf(md(`name: a\n${big}`))).toBe("skill_frontmatter_too_large");
    expect(errorOf(`---\nname: a\n${big}\n`)).toBe("skill_frontmatter_too_large");
  });

  it("refuses YAML that does not parse, repeats a key, uses a custom tag or is not a mapping", () => {
    expect(errorOf(md("name: [a"))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md("name: a\nname: b\ndescription: d"))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md("name: !!js/function 'x'\ndescription: d"))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md("- name: a"))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md(""))).toBe("skill_frontmatter_invalid");
  });

  it("enforces the name format and the required description", () => {
    for (const name of ["Evidence Summary", "pdf_forms", "-pdf", "pdf-", "pdf--forms", "a".repeat(65), '"tab\tname"', "123: x"]) {
      expect(errorOf(md(`name: ${name}\ndescription: d`)), name).toBe("skill_frontmatter_invalid");
    }
    expect(errorOf(md("name: a"))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md('name: a\ndescription: "   "'))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md(`name: a\ndescription: ${"d".repeat(1025)}`))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md("name: 7\ndescription: d"))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md('name: a\ndescription: "line\\u0007bell"'))).toBe("skill_frontmatter_invalid");
  });

  it("one-line fields refuse line breaks and tabs; a folded block's trailing newline is trimmed", () => {
    expect(errorOf(md("name: a\ndescription: |\n  line one\n  line two"))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md('name: a\ndescription: "tab\\there"'))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md("name: a\ndescription: d\nlicense: |\n  MIT\n  and more"))).toBe("skill_frontmatter_invalid");
    expect(validateSkillMarkdown(md("name: a\ndescription: >\n  folded onto\n  one line"))).toMatchObject({ ok: true, skill: { description: "folded onto one line" } });
  });

  it("refuses a body over the stored cap before reading it", () => {
    expect(errorOf(md("name: a\ndescription: d", "x".repeat(SKILL_BODY_MAX_CHARS + 1)))).toBe("skill_body_too_long");
    expect(errorOf(md("name: a\ndescription: d", "x".repeat(SKILL_BODY_MAX_CHARS)))).toBeNull();
  });

  it("refuses a field the format does not define, and a bad optional field", () => {
    expect(errorOf(md("name: a\ndescription: d\nversion: 2"))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md(`name: a\ndescription: d\ncompatibility: ${"c".repeat(501)}`))).toBe("skill_frontmatter_invalid");
    expect(errorOf(md("name: a\ndescription: d\nmetadata:\n  nested:\n    deep: x"))).toBe("skill_frontmatter_invalid");
    const many = Array.from({ length: 33 }, (_, i) => `  k${i}: v`).join("\n");
    expect(errorOf(md(`name: a\ndescription: d\nmetadata:\n${many}`))).toBe("skill_frontmatter_invalid");
  });

  it("refusals carry fixed text, never the file's own strings", () => {
    const r = validateSkillMarkdown(md("name: a\ndescription: d\nIGNORE_PREVIOUS: yes"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).not.toContain("IGNORE_PREVIOUS");
  });

  it("enforces the progressive-loading layout: a bounded body and references inside the skill", () => {
    const long = Array.from({ length: SKILL_BODY_MAX_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
    expect(errorOf(md("name: a\ndescription: d", long))).toBe("skill_layout_invalid");
    expect(errorOf(md("name: a\ndescription: d", Array.from({ length: SKILL_BODY_MAX_LINES }, () => "x").join("\n")))).toBeNull();
    for (const target of ["../secrets.md", "/etc/passwd", "~/x", "scripts\\run.ps1", "file:///etc/passwd", "refs/%2e%2e/x.md", "a/../../b"]) {
      expect(errorOf(md("name: a\ndescription: d", `See [x](${target}).`)), target).toBe("skill_layout_invalid");
    }
    for (const target of ["scripts/run.py", "references/REFERENCE.md#top", "#section", "https://example.com", "mailto:a@example.com"]) {
      expect(errorOf(md("name: a\ndescription: d", `See [x](${target}).`)), target).toBeNull();
    }
  });
});
