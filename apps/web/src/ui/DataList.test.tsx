/**
 * ADR-0226 — the list control's markup, rendered with react-dom/server: the kit Table under a server sort (rows are
 * not re-sorted in the browser, the active header carries aria-sort, headers are buttons), and DataList's toolbar
 * (named icon buttons with their tips, the page-size control, the main columns only, a not-sortable column saying so).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { Table } from "./kit";
import { DataList, type DataColumn } from "./DataList";

type Row = { id: string; name: string };

describe("Table with a server sort", () => {
  it("keeps the server's order and marks the sorted header", () => {
    const html = renderToStaticMarkup(
      <Table<Row>
        columns={[
          { key: "name", header: "Name", sort: () => 0, render: (r) => r.name },
          { key: "id", header: "Id", render: (r) => r.id },
        ]}
        rows={[
          { id: "1", name: "zeta" },
          { id: "2", name: "alpha" },
        ]}
        rowKey={(r) => r.id}
        sort={{ key: "name", dir: -1, by: () => {} }}
      />,
    );
    expect(html.indexOf("zeta")).toBeLessThan(html.indexOf("alpha"));
    expect(html).toMatch(/<th[^>]*aria-sort="descending"[^>]*><button type="button"[^>]*>Name<\/button>/);
    expect(html).not.toMatch(/<th[^>]*aria-sort[^>]*>Id/);
  });
});

describe("DataList", () => {
  const columns: Array<DataColumn<Row>> = [
    { key: "name", header: "Run", main: true, sortable: true, render: (r) => r.name },
    { key: "status", header: "Status", main: true, sortable: true, required: "Status is always shown", render: () => "ok" },
    { key: "progress", header: "Progress", main: true, render: () => "1/2" },
    { key: "cap", header: "Budget cap", sortable: true, render: () => "—" },
  ];
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <DataList<Row>
        listId="runs"
        noun="runs"
        endpoint="/v1/runs"
        exportPath="/v1/runs/export.xlsx"
        queryKey={["runs", "list"]}
        legacyKey="runs"
        columns={columns}
        defaultSort={{ key: "name", dir: "asc" }}
        rowKey={(r) => r.id}
      />
    </QueryClientProvider>,
  );

  it("names its icon buttons by a tip that is not hover-only markup", () => {
    const tip = /<button type="button" class="[^"]*" aria-labelledby="([^"]+)"[^>]*>.*?<\/button><span role="tooltip" id="([^"]+)"[^>]*>Refresh runs<\/span>/.exec(html);
    expect(tip).not.toBeNull();
    expect(tip![1]).toBe(tip![2]);
    expect(html).toContain(">Choose columns for runs</span>");
    expect(html).toContain(">Download Excel</button>");
  });

  it("offers 10, 50, 100 and All, starting at 10", () => {
    expect(html).toContain("Rows per page");
    expect(html).toMatch(/<option value="10" selected="">10<\/option><option value="50">50<\/option><option value="100">100<\/option><option value="all">All<\/option>/);
  });

  it("shows the main columns only, sortable ones as buttons, and says which cannot be sorted", () => {
    expect(html).toContain(">Run</button>");
    expect(html).toContain(">Status</button>");
    expect(html).not.toContain("Budget cap");
    expect(html).toMatch(/Progress<span[^>]*><button[^>]*aria-label="What is the Progress column\?"/);
    expect(html).toContain('aria-sort="ascending"');
  });
});
