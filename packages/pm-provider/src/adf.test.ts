import { describe, expect, it } from "vitest";
import { adfToText, textToAdf, type AdfNode } from "./adf.js";

const MIXED = [
  "# Deploy plan",
  "",
  "Roll out the gateway change.",
  "Then verify the audit trail.",
  "",
  "## Steps",
  "",
  "- build the package",
  "- run the suite",
  "",
  "1. first pass",
  "2. second pass",
  "",
  "```ts",
  'const x = "governed";',
  "```",
].join("\n");

describe("textToAdf (plain-ish text → ADF document)", () => {
  it("blank-line-separated paragraphs become paragraph nodes; in-paragraph newlines become hardBreak", () => {
    const doc = textToAdf("first para line one\nline two\n\nsecond para");
    expect(doc).toEqual({
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "first para line one" },
            { type: "hardBreak" },
            { type: "text", text: "line two" },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "second para" }] },
      ],
    });
  });

  it("#-headings carry their level, capped at 6", () => {
    const doc = textToAdf("## Two\n\n######## Deep");
    expect(doc.content[0]).toEqual({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Two" }],
    });
    expect(doc.content[1]!.attrs).toEqual({ level: 6 });
  });

  it("bullet and numbered runs become bulletList/orderedList with listItem > paragraph", () => {
    const doc = textToAdf("- a\n* b\n\n1. one\n2) two");
    expect(doc.content[0]).toEqual({
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
      ],
    });
    expect(doc.content[1]!.type).toBe("orderedList");
    expect(doc.content[1]!.content).toHaveLength(2);
  });

  it("code fences become codeBlock nodes with the language from the info string", () => {
    const doc = textToAdf("```python\nprint(1)\nprint(2)\n```");
    expect(doc.content).toEqual([
      {
        type: "codeBlock",
        attrs: { language: "python" },
        content: [{ type: "text", text: "print(1)\nprint(2)" }],
      },
    ]);
    // no info string → no language attr; unclosed fence still never throws
    expect(textToAdf("```\ncode").content[0]).toEqual({
      type: "codeBlock",
      content: [{ type: "text", text: "code" }],
    });
  });

  it("is total: empty input becomes a doc with one empty paragraph", () => {
    expect(textToAdf("")).toEqual({ version: 1, type: "doc", content: [{ type: "paragraph" }] });
    expect(textToAdf("   \n\n ")).toEqual(textToAdf(""));
  });

  it("round-trips the mixed document through adfToText verbatim", () => {
    const doc = textToAdf(MIXED);
    expect(doc.version).toBe(1);
    expect(doc.type).toBe("doc");
    expect(adfToText(doc)).toBe(MIXED);
    // and the reconstruction is a fixed point: converting again is stable
    expect(adfToText(textToAdf(adfToText(doc)))).toBe(MIXED);
  });
});

describe("adfToText (ADF document → readable text)", () => {
  it("tolerates unknown node types by descending into their content, and passes strings through", () => {
    const doc = {
      version: 1,
      type: "doc",
      content: [
        {
          type: "panel", // unknown block wrapper
          attrs: { panelType: "info" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "inside a panel" }] }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "ping " },
            { type: "mention", attrs: { id: "u1" }, content: [{ type: "text", text: "@dana" }] },
          ],
        },
      ] as AdfNode[],
    };
    expect(adfToText(doc)).toBe("inside a panel\n\nping @dana");
    // reads of v2-style plain strings and junk stay total
    expect(adfToText("already plain")).toBe("already plain");
    expect(adfToText(null)).toBe("");
    expect(adfToText(42)).toBe("");
  });
});
