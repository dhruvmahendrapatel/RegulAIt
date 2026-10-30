/**
 * PENDING P3 — the posture estimate renders as an estimate with its disclaimer on its face, its weights and formulae
 * one disclosure away, unmeasured objectives named, and every action with its reason and a link to fix it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PostureEstimate, type PostureScoreDoc } from "./PostureEstimate";

const doc: PostureScoreDoc = {
  estimate: true,
  score: 42,
  scale: { min: 0, max: 100 },
  method: "The weighted mean of seven objective scores.",
  disclaimer: "An estimate computed from this deployment's own records. It is not a compliance verdict.",
  objectives: [
    {
      id: "coverage",
      title: "Control coverage",
      outcome: "Every mapped control has evidence.",
      metric: { label: "Mean evidenced share across active packs", value: "70%" },
      weight: 20,
      measured: true,
      score: 70,
      contribution: 14,
      inputs: [{ label: "Pack A", value: "70% evidenced" }],
      formula: "The mean of each active pack's evidenced share.",
      link: { to: "/admin/compliance-packs", label: "Open compliance packs" },
    },
    {
      id: "spend",
      title: "Spend control",
      outcome: "Projects stay within budget.",
      metric: { label: "Budgeted projects within budget", value: "unmeasured" },
      weight: 10,
      measured: false,
      score: 0,
      contribution: 0,
      inputs: [{ label: "Projects with a budget", value: "0" }],
      formula: "No budget set scores 0.",
      link: { to: "/admin/cost", label: "Open the cost dashboard" },
    },
  ],
  actions: [
    {
      key: "spend:budget",
      rank: 1,
      title: "Set a budget on the projects that use AI",
      points: 10,
      reason: "Worth up to 10 points once measured: no project has a budget.",
      link: { to: "/admin/cost", label: "Open the cost dashboard" },
    },
  ],
};

const html = (d: PostureScoreDoc) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PostureEstimate score={d} />
    </MemoryRouter>,
  );

describe("PostureEstimate", () => {
  it("labels the score an estimate and shows the disclaimer on its face", () => {
    const h = html(doc);
    expect(h).toContain("Posture estimate");
    expect(h).toContain("Estimate");
    expect(h).toContain(doc.disclaimer.replace(/'/g, "&#x27;"));
    expect(h).toMatch(/role="meter"[^>]*aria-label="Posture estimate: 42 out of 100"/);
    expect(h.toLowerCase()).not.toMatch(/\bcompliant\b|\bcertified\b/);
  });

  it("shows every objective's weight, inputs and formula, and names the unmeasured one", () => {
    const h = html(doc);
    expect(h).toContain("How this is calculated");
    for (const o of doc.objectives) {
      expect(h).toContain(o.title);
      expect(h).toContain(`${o.weight}%`);
      expect(h).toContain(o.formula.replace(/'/g, "&#x27;"));
      for (const i of o.inputs) expect(h).toContain(i.label);
    }
    expect(h).toContain("Unmeasured");
  });

  it("lists actions in rank order with the reason for the rank and a link to fix each", () => {
    const h = html(doc);
    expect(h).toContain("What to fix first");
    expect(h).toContain(doc.actions[0]!.reason);
    expect(h).toContain('href="/admin/cost"');
  });

  it("says so plainly when there is nothing to fix", () => {
    expect(html({ ...doc, actions: [] })).toContain("Nothing to fix");
  });
});
