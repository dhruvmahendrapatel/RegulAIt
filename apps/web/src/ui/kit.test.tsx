/**
 * UXJ-01 — a list whose query FAILED must not read as "no rows yet". Rendered
 * with react-dom/server: no DOM, no browser, just the markup the Table emits.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { EmptyState, Table } from "./kit";

type Row = { id: string; name: string };
const columns = [{ key: "name", header: "Name", render: (r: Row) => r.name }];
const render = (props: Partial<Parameters<typeof Table<Row>>[0]>) =>
  renderToStaticMarkup(
    <Table<Row>
      columns={columns}
      rows={[]}
      rowKey={(r) => r.id}
      empty={<EmptyState title="No users yet" />}
      {...props}
    />,
  );

describe("Table — error versus empty", () => {
  it("renders the empty state only when the query succeeded with nothing", () => {
    const html = render({});
    expect(html).toContain("No users yet");
    expect(html).not.toContain("role=\"alert\"");
  });

  it("renders an error state with Retry — never the empty state — when the query failed", () => {
    const html = render({ error: new ApiError(500, { error: "internal", detail: "db unavailable" }), onRetry: () => {} });
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("Couldn&#x27;t load this list");
    expect(html).toContain("internal — db unavailable");
    expect(html).toContain(">Retry<");
    expect(html).not.toContain("No users yet");
  });

  it("names a 403 as an access refusal, not a load failure", () => {
    const html = render({ error: new ApiError(403, { error: "forbidden" }) });
    expect(html).toContain("You don&#x27;t have access to this view");
    expect(html).not.toContain("No users yet");
  });

  it("keeps rows it has even when a later refetch failed, and shows neither state while loading", () => {
    const withRows = render({ rows: [{ id: "1", name: "Avery" }], error: new Error("boom") });
    expect(withRows).toContain("Avery");
    expect(withRows).not.toContain("role=\"alert\"");
    const loading = render({ loading: true, error: new Error("boom") });
    expect(loading).not.toContain("role=\"alert\"");
    expect(loading).not.toContain("No users yet");
  });
});
