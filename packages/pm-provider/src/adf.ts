/**
 * ADF (Atlassian Document Format) conversion for the Jira adapter's REST v3
 * mode (v2 keeps plain strings; see the Jira section in index.ts).
 *
 * textToAdf turns the plain-ish text RegulAIt produces (node instructions,
 * artifact content, decision rationales) into a valid ADF document
 * ({ version: 1, type: "doc", content: [...] }): blank-line-separated
 * paragraphs, `#`-headings (level from the #-count, capped at 6), `-`/`*`
 * bullet lists, numbered lists (listItem > paragraph), and triple-backtick
 * code fences (language from the fence info string). Text runs stay PLAIN —
 * inline marks (bold, italics, links, …) are deliberately out of scope.
 * Deterministic and total: never throws; empty input becomes a doc with one
 * empty paragraph. Line breaks inside a paragraph become hardBreak nodes so
 * the conversion round-trips.
 *
 * adfToText is the read-side inverse for v3 payloads: it walks an ADF tree
 * back into readable text (headings to #-prefixes, lists to bullets/numbers,
 * code blocks to fences, hardBreak to newline) and TOLERATES unknown node
 * types by descending into their content rather than dropping them. A plain
 * string passes through unchanged; anything unrenderable becomes "".
 */

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
}

export interface AdfDoc {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

const textNode = (text: string): AdfNode => ({ type: "text", text });

/** Paragraph lines joined with hardBreak inline nodes; ADF text nodes must be
 * non-empty, so an empty paragraph simply carries no content key. */
function paragraph(lines: string[]): AdfNode {
  const content: AdfNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: "hardBreak" });
    if (line) content.push(textNode(line));
  });
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

const listItem = (text: string): AdfNode => ({ type: "listItem", content: [paragraph([text])] });

export function textToAdf(text: string): AdfDoc {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      content.push(paragraph(para));
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      flushPara();
      const language = fence[1]!.trim();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        code.push(lines[i]!);
        i += 1;
      } // an unclosed fence swallows the rest of the input — deterministic, never throws
      const body = code.join("\n");
      content.push({
        type: "codeBlock",
        ...(language ? { attrs: { language } } : {}),
        ...(body ? { content: [textNode(body)] } : {}),
      });
      continue;
    }
    const heading = /^(#+)\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      content.push({
        type: "heading",
        attrs: { level: Math.min(heading[1]!.length, 6) },
        ...(heading[2] ? { content: [textNode(heading[2]!)] } : {}),
      });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      const items = [bullet[1]!];
      while (i + 1 < lines.length) {
        const next = /^[-*]\s+(.*)$/.exec(lines[i + 1]!);
        if (!next) break;
        items.push(next[1]!);
        i += 1;
      }
      content.push({ type: "bulletList", content: items.map(listItem) });
      continue;
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushPara();
      const items = [ordered[1]!];
      while (i + 1 < lines.length) {
        const next = /^\d+[.)]\s+(.*)$/.exec(lines[i + 1]!);
        if (!next) break;
        items.push(next[1]!);
        i += 1;
      }
      content.push({ type: "orderedList", content: items.map(listItem) });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushPara();
  if (!content.length) content.push({ type: "paragraph" });
  return { version: 1, type: "doc", content };
}

/** Inline flattening: text nodes concatenate, hardBreak is a newline, and an
 * unknown inline node (mention, emoji, …) contributes whatever text its own
 * content carries rather than vanishing. */
function inlineText(nodes: unknown): string {
  if (!Array.isArray(nodes)) return "";
  let out = "";
  for (const raw of nodes) {
    if (raw === null || typeof raw !== "object") continue;
    const n = raw as AdfNode;
    if (n.type === "hardBreak") out += "\n";
    else if (typeof n.text === "string") out += n.text;
    else out += inlineText(n.content);
  }
  return out;
}

/** One list item renders its blocks joined by newlines — the common
 * listItem > paragraph shape reduces to the paragraph's text. */
const listItemText = (item: AdfNode): string =>
  renderBlocks(Array.isArray(item.content) ? item.content : []).join("\n");

function renderBlocks(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return [];
  const out: string[] = [];
  for (const raw of nodes) {
    if (raw === null || typeof raw !== "object") continue;
    const n = raw as AdfNode;
    switch (n.type) {
      case "paragraph":
        out.push(inlineText(n.content));
        break;
      case "heading": {
        const rawLevel = Number(n.attrs?.level);
        const level = Number.isFinite(rawLevel) ? Math.min(Math.max(rawLevel, 1), 6) : 1;
        out.push(`${"#".repeat(level)} ${inlineText(n.content)}`.trimEnd());
        break;
      }
      case "bulletList":
        out.push(
          (Array.isArray(n.content) ? n.content : []).map((item) => `- ${listItemText(item)}`).join("\n"),
        );
        break;
      case "orderedList": {
        const start = Number(n.attrs?.order);
        const base = Number.isFinite(start) ? start : 1;
        out.push(
          (Array.isArray(n.content) ? n.content : [])
            .map((item, i) => `${base + i}. ${listItemText(item)}`)
            .join("\n"),
        );
        break;
      }
      case "codeBlock": {
        const lang = n.attrs?.language;
        out.push("```" + (typeof lang === "string" ? lang : "") + "\n" + inlineText(n.content) + "\n```");
        break;
      }
      default:
        // unknown block (panel, blockquote, table, …): descend, never drop
        if (typeof n.text === "string") out.push(n.text);
        else out.push(...renderBlocks(n.content));
    }
  }
  return out;
}

export function adfToText(doc: unknown): string {
  if (typeof doc === "string") return doc;
  if (doc === null || typeof doc !== "object") return "";
  const blocks = renderBlocks((doc as AdfNode).content);
  return blocks.filter((b) => b.trim() !== "").join("\n\n");
}
