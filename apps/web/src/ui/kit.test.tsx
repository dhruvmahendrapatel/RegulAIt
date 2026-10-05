/**
 * UXJ-01 — a list whose query FAILED must not read as "no rows yet". Rendered
 * with react-dom/server: no DOM, no browser, just the markup the Table emits.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { EmptyState, Field, Fieldset, Input, RecordError, Table } from "./kit";

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
    expect(html).toContain("Something went wrong on the server");
    expect(html).toContain("— db unavailable");
    expect(html).toContain(">Retry<");
    expect(html).not.toContain("No users yet");
  });

  it("names a 403 as an access refusal, not a load failure", () => {
    const html = render({ error: new ApiError(403, { error: "forbidden" }) });
    expect(html).toContain("You don&#x27;t have access to this view");
    expect(html).not.toContain("No users yet");
  });

  it("keeps rows it has when a later refetch failed — and says so — and shows neither state while loading", () => {
    const withRows = render({ rows: [{ id: "1", name: "Avery" }], error: new Error("boom"), onRetry: () => {} });
    expect(withRows).toContain("Avery");
    expect(withRows).toContain("Couldn&#x27;t refresh this list");
    expect(withRows).toContain("boom");
    expect(withRows).toContain("Retry");
    expect(withRows).not.toContain("Couldn&#x27;t load this list");
    expect(withRows).not.toContain("No users yet");
    const loading = render({ loading: true, error: new Error("boom") });
    expect(loading).not.toContain("role=\"alert\"");
    expect(loading).not.toContain("No users yet");
  });
});

describe("RecordError — a missing record is named, not retried (UIW-08)", () => {
  const html = (status: number, payload: Record<string, unknown>) =>
    renderToStaticMarkup(<RecordError noun="run" error={new ApiError(status, payload)} onRetry={() => {}} action={<a href="/runs">All runs</a>} />);

  it("a 404 says there is no such record, offers the way back, and no Retry", () => {
    const h = html(404, { error: "unavailable" });
    expect(h).toContain("No such run");
    expect(h).toContain("There is no run with this ID");
    expect(h).toContain("All runs");
    expect(h).not.toContain(">Retry<");
    expect(h).not.toContain("unavailable");
  });

  it("a malformed id is the link's fault, not the server's", () => {
    const h = html(400, { error: "validation", issues: [{ path: ["runId"], message: "Invalid uuid" }] });
    expect(h).toContain("No such run");
    expect(h).toContain("This is not a run ID");
    expect(h).not.toContain("Invalid uuid");
    expect(h).not.toContain(">Retry<");
  });

  it("a 403 is an access refusal; anything else keeps Retry and the sentence", () => {
    expect(html(403, { error: "unavailable" })).toContain("You don&#x27;t have access to this run");
    const h = html(500, { error: "internal_error" });
    expect(h).toContain("Couldn&#x27;t load this run");
    expect(h).toContain("Something went wrong on the server");
    expect(h).toContain(">Retry<");
  });
});

describe("Field grow — a real flex basis, so the field wraps before it shrinks to nothing (UIW-05)", () => {
  it("renders the grow class and no inline flex style", () => {
    const html = renderToStaticMarkup(<Field label="Title" grow><Input /></Field>);
    expect(html).toContain("fieldGrow");
    expect(html).not.toContain("style=\"flex:1\"");
    const plain = renderToStaticMarkup(<Field label="Title"><Input /></Field>);
    expect(plain).not.toContain("fieldGrow");
  });
});

describe("Field help — explanatory controls keep the input label intact", () => {
  it("renders a labelled information button beside, never inside, the label", () => {
    const html = renderToStaticMarkup(
      <Field label="Use-case name" helpLabel="the inventory identifier created here" help={<p>This becomes the inventory name.</p>}>
        <Input />
      </Field>,
    );

    expect(html).toContain("What is the inventory identifier created here?");
    expect(html).toContain("for=\"");
    expect(html).toContain("id=\"");
    expect(html).not.toMatch(/<label[^>]*>[^<]*<button/);
  });
});

describe("Fieldset — a group of boxes is named as a group, not by a label (AER-029)", () => {
  const html = renderToStaticMarkup(
    <Fieldset legend="Sectors — select all that apply">
      <label><input type="checkbox" aria-label="Sectors: Healthcare" /><span>Healthcare</span></label>
      <label><input type="checkbox" aria-label="Sectors: Payments" /><span>Payments</span></label>
    </Fieldset>,
  );

  it("renders a fieldset whose FIRST child is the legend carrying the caption", () => {
    expect(html).toMatch(/^<fieldset[^>]*><legend[^>]*>Sectors — select all that apply<\/legend>/);
    expect(html).toMatch(/<\/fieldset>$/);
  });

  it("never wraps the group in a <label> — a label names one control, and each option is a label already", () => {
    expect(html.startsWith("<label")).toBe(false);
    expect(html).not.toMatch(/<label[^>]*>(?:(?!<\/label>).)*<label/);
    // each option keeps its own name
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("aria-label=\"Sectors: Healthcare\"");
    expect(html).toContain("aria-label=\"Sectors: Payments\"");
  });
});
