/**
 * #458 review Low — a count of 0 was hidden: `n ? …` treated 0 as "no count", so a use case with no risks showed
 * "Risks", not "Risks 0". Risks, Approvals and Audit show exact counts, so 0 is a count like any other.
 * Rendered with react-dom/server (no DOM, no network).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { withTabCount } from "./UseCaseOverviewPage";

const data = { risks: [], approvals: [], audit: [], auditTotal: 0 } as never;
const label = (id: string, text: string) => renderToStaticMarkup(<>{withTabCount({ id, label: text }, data).label}</>);

describe("use-case overview tab counts (#458)", () => {
  it("a count of 0 is shown, not hidden", () => {
    expect(label("risks", "Risks")).toMatch(/^Risks <span[^>]*>0<\/span>$/);
    expect(label("approvals", "Approvals")).toMatch(/>0<\/span>$/);
    expect(label("audit", "Audit")).toMatch(/>0<\/span>$/);
  });
  it("a tab with no count stays a bare label", () => {
    expect(label("overview", "Overview")).toBe("Overview");
  });
});
