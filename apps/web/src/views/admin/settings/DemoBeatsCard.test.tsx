/**
 * ADR-0202 lane L review finding 5 — the demo-beats card as the presenter sees it: a skeleton while the read is in
 * flight, an error with Retry when it fails, and each switched beat's last reason (who and when are in the audit log).
 * Rendered with react-dom/server from seeded query data (no DOM, no network).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import DemoBeatsCard from "./DemoBeatsCard";

const KEY = ["admin", "demo-beats"];

function render(seed: (qc: QueryClient) => void): string {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <DemoBeatsCard />
    </QueryClientProvider>,
  );
}

describe("DemoBeatsCard", () => {
  it("shows a skeleton while the beats load", () => {
    const html = render(() => {});
    expect(html).toMatch(/skeleton/i);
    expect(html).not.toContain("Retry");
  });

  it("shows an error with Retry when the read fails", () => {
    const html = render((qc) =>
      qc.getQueryCache().build(qc, { queryKey: KEY }).setState({ status: "error", error: new Error("gateway unavailable"), fetchStatus: "idle" }),
    );
    expect(html).toContain("gateway unavailable");
    expect(html).toContain("Retry");
  });

  it("shows a switched beat's last reason on its badge, and none for an untouched beat", () => {
    const html = render((qc) =>
      qc.setQueryData(KEY, {
        beats: [
          { beatId: "pm-sync", label: "PM sync", mode: "simulated", live: "", simulated: "", reason: "Jira is down" },
          { beatId: "git-pr", label: "Git PR", mode: "live", live: "", simulated: "", reason: null },
        ],
      }),
    );
    expect(html).toContain('title="Jira is down"');
    expect(html.match(/title="/g)).toHaveLength(1);
    expect(html).toContain("Go live");
    expect(html).toContain("Simulate");
  });

  it("renders an empty card, not a crash, when the reply has no beats list", () => {
    const html = render((qc) => qc.setQueryData(KEY, {}));
    expect(html).toContain("Demo beats: live or simulated");
    expect(html).not.toContain("Simulate");
  });
});
