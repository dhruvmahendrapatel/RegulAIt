/**
 * GX slice 1 (#1180 review, "unknown is not zero"): the Shadow-AI inventory's status filter chips show "—" until the
 * findings summary has been read, and the real figures once it has. A pending or failed read is never "Open 0".
 * Rendered with react-dom/server from seeded query data (no DOM, no network).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import ShadowAiPage from "./ShadowAiPage";

const chipsOf = (html: string) => {
  const start = html.indexOf('aria-label="Filter by status"');
  expect(start, "the status filter group renders").toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</div>", start)).replace(/<!-- -->/g, "");
};

const render = (findings?: unknown) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  if (findings) client.setQueryData(["shadow-ai", "findings", "summary"], findings);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ShadowAiPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe("Shadow-AI status chips: unknown is not zero", () => {
  it("shows no count before the findings summary is read", () => {
    const chips = chipsOf(render());
    for (const label of ["All", "Open", "Confirmed", "Closed"]) expect(chips).toContain(`${label} —`);
    expect(chips).not.toMatch(/(All|Open|Confirmed|Closed) 0/);
  });

  it("shows the server's figures once read, a genuine zero included", () => {
    const chips = chipsOf(
      render({
        findings: [],
        coverage: { sources: [], sourcesOn: 0, sourcesPossible: 3, statement: "" },
        posture: "",
        summary: {
          bySeverity: { critical: 0, high: 2, medium: 0, low: 0 },
          statusCounts: { all: 5, open: 2, confirmed: 3 },
          criticalOpen: 0,
          seenAgain: [],
          seenAgainTotal: 0,
        },
      }),
    );
    expect(chips).toContain("All 5");
    expect(chips).toContain("Open 2");
    expect(chips).toContain("Confirmed 3");
    expect(chips).toContain("Closed 0");
  });
});
