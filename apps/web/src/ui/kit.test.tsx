/**
 * UXJ-01 — a list whose query FAILED must not read as "no rows yet". Rendered
 * with react-dom/server: no DOM, no browser, just the markup the Table emits.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { Badge, Card, EmptyState, Field, Fieldset, InfoButton, Input, RecordError, RowActions, Table, Tabs, foldPattern, tabIds } from "./kit";
import { FoldTable, foldHosts } from "./fold";
// Digest lives with the BOM evidence panel; it is tested here with the other shared primitives
import { Digest } from "../views/admin/governance/BomEvidencePanel";

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

describe("Tabs — ids tie each tab to its panel, and only the selected tab names one", () => {
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "risks", label: "Risks" },
    { id: "audit", label: "Audit" },
  ];
  /** each rendered tab's attributes, in order */
  const tabAttrs = (html: string) =>
    [...html.matchAll(/<button([^>]*)>/g)].map((m) => {
      const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(m[1]!)?.[1];
      return { id: attr("id"), controls: attr("aria-controls"), selected: attr("aria-selected"), tabIndex: attr("tabindex"), role: attr("role") };
    });

  it("tabIds builds the tab and panel ids from one prefix", () => {
    expect(tabIds("uc", "risks")).toEqual({ tab: "uc-tab-risks", panel: "uc-panel-risks" });
  });

  it("with idPrefix: every tab has its id; ONLY the selected tab has aria-controls, naming its panel", () => {
    const html = renderToStaticMarkup(<Tabs tabs={tabs} active="risks" onChange={() => {}} idPrefix="uc" />);
    expect(html).toContain('role="tablist"');
    expect(tabAttrs(html)).toEqual([
      { id: "uc-tab-overview", controls: undefined, selected: "false", tabIndex: "-1", role: "tab" },
      { id: "uc-tab-risks", controls: "uc-panel-risks", selected: "true", tabIndex: "0", role: "tab" },
      { id: "uc-tab-audit", controls: undefined, selected: "false", tabIndex: "-1", role: "tab" },
    ]);
    // never a dangling reference to a panel that is not rendered
    expect(html).not.toContain("uc-panel-overview");
    expect(html).not.toContain("uc-panel-audit");
  });

  it("without idPrefix: no ids and no aria-controls at all", () => {
    const html = renderToStaticMarkup(<Tabs tabs={tabs} active="overview" onChange={() => {}} />);
    for (const t of tabAttrs(html)) {
      expect(t.id).toBeUndefined();
      expect(t.controls).toBeUndefined();
    }
  });

  it("an active id that matches no tab selects nothing and keeps the first tab as the tab stop", () => {
    const html = renderToStaticMarkup(<Tabs tabs={tabs} active="gone" onChange={() => {}} idPrefix="uc" />);
    const attrs = tabAttrs(html);
    expect(attrs.map((t) => t.selected)).toEqual(["false", "false", "false"]);
    expect(attrs.map((t) => t.tabIndex)).toEqual(["0", "-1", "-1"]);
    expect(attrs.every((t) => t.controls === undefined)).toBe(true);
  });
});

describe("Digest — sighted users see a prefix, assistive tech gets the full value", () => {
  const value = "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

  it("hides the truncated prefix from assistive tech and gives it the whole digest", () => {
    const html = renderToStaticMarkup(<Digest value={value} />);
    // the visible prefix is aria-hidden …
    expect(html).toContain(`<span aria-hidden="true">${value.slice(0, 16)}…</span>`);
    // … and the full value is in the accessible text (visually hidden, not aria-hidden)
    const srOnly = /<span style="([^"]*)">([^<]*)<\/span>/.exec(html);
    expect(srOnly?.[2]).toBe(value);
    expect(srOnly?.[1]).toContain("position:absolute");
    expect(srOnly?.[1]).toContain("clip:rect(0, 0, 0, 0)");
    // and the pointer tooltip carries it too
    expect(html).toContain(`title="${value}"`);
  });

  it("a value shorter than the prefix is still given whole", () => {
    const html = renderToStaticMarkup(<Digest value="abc" />);
    expect(html).toContain('<span aria-hidden="true">abc…</span>');
    expect(html).toMatch(/<span style="[^"]*">abc<\/span>/);
  });
});

describe("InfoTip slots — every (i) is a real, named button (X1)", () => {
  it("names the Card title's (i) after the title and keeps it out of the heading text", () => {
    const html = renderToStaticMarkup(<Card title="Coverage" info="What each evidence class can see.">body</Card>);
    expect(html).toContain('aria-label="What is Coverage?"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("puts a column header's (i) inside the header cell, named by the header", () => {
    const html = render({
      columns: [{ key: "confidence", header: "Confidence", info: "How sure the match is.", render: (r: Row) => r.name }],
      rows: [{ id: "1", name: "high" }],
    });
    expect(html).toMatch(/<th[^>]*>Confidence<span[^>]*><button[^>]*aria-label="What is Confidence\?"/);
  });

  it("gives a Badge's explanation a focusable button instead of a hover-only title (X2)", () => {
    const html = renderToStaticMarkup(<Badge tone="warn" info="A recorded reason is required.">Your own request</Badge>);
    expect(html).toContain('aria-label="What is Your own request?"');
    expect(html).not.toContain("title=");
  });

  it("renders a closed InfoButton without its panel", () => {
    const html = renderToStaticMarkup(<InfoButton label="residual risk" term="Residual risk">After controls.</InfoButton>);
    expect(html).not.toContain('role="note"');
  });
});

describe("Card contain — a long body scrolls in a contained box (X6)", () => {
  it("is not a tab stop or a landmark until the box is known to scroll", () => {
    const html = renderToStaticMarkup(<Card title="Findings" contain>rows</Card>);
    expect(html).toContain(">rows<");
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain('role="region"');
  });

  it("offers Expand only once the body is known to be long, so short cards look as they did", () => {
    const html = renderToStaticMarkup(<Card title="Findings" contain>rows</Card>);
    expect(html).not.toContain(">Expand<");
  });

  it("shows the row count cue beside the title, with a plural that agrees", () => {
    expect(renderToStaticMarkup(<Card title="Findings" contain count={42}>rows</Card>)).toContain(">42 rows<");
    expect(renderToStaticMarkup(<Card title="Findings" contain count={1}>rows</Card>)).toContain(">1 row<");
    expect(renderToStaticMarkup(<Card title="Audit" contain count={3} countNoun={["entry", "entries"]}>rows</Card>)).toContain(
      ">3 entries<",
    );
  });

  it("offers the fold only where the caller supplies a count (X6b, M1)", () => {
    // @ts-expect-error a foldable card must say how many rows it holds, so its folded header keeps the count
    void (<Card title="Findings" contain foldable>rows</Card>);
    // @ts-expect-error a secondary section can start collapsed only when it can fold
    void (<Card title="Findings" contain startCollapsed count={3}>rows</Card>);
    const plain = renderToStaticMarkup(<Card title="Findings" contain count={3}>rows</Card>);
    expect(plain).not.toContain("aria-expanded");
    const fold = renderToStaticMarkup(<Card title="Findings" contain foldable count={3}>rows</Card>);
    expect(fold).toContain('aria-expanded="true"');
    expect(fold).toContain(">3 rows<");
  });

  it("keys a remembered fold on the route pattern, an encoded id included (X6b, N2)", () => {
    expect(foldPattern("/ui/x/abc/tab", { id: "abc" })).toBe("/ui/x/:id/tab");
    // useParams decodes, location.pathname does not
    expect(foldPattern("/ui/x/a%20b%2Fc", { id: "a b/c" })).toBe("/ui/x/:id");
    expect(foldPattern("/ui/x/100%25", { id: "100%" })).toBe("/ui/x/:id");
    // a splat is not a record id, and a malformed escape is kept
    expect(foldPattern("/ui/docs/a%zz", { "*": "a%zz" })).toBe("/ui/docs/a%zz");
  });

  it("says when the body is filtered or the count is a fetch limit", () => {
    expect(renderToStaticMarkup(<Card title="Inventory" contain count={2} total={5} countNoun={["finding", "findings"]}>rows</Card>)).toContain(
      ">2 of 5 findings<",
    );
    expect(renderToStaticMarkup(<Card title="Runs" contain count={50} countIsLimit countNoun={["run", "runs"]}>rows</Card>)).toContain(">50+ runs<");
  });

  it("leaves a card without contain exactly as before", () => {
    const html = renderToStaticMarkup(<Card title="Findings">rows</Card>);
    expect(html).not.toContain('role="region"');
  });
});

describe("RowActions — fixed slots keep every row's primary button in one column (X7)", () => {
  it("keeps the primary slot even when a row has no primary action", () => {
    const html = renderToStaticMarkup(<RowActions secondary={<button>Triage</button>} />);
    expect(html).toMatch(/^<div[^>]*><span><\/span><span><button>Triage<\/button><\/span><span><\/span><\/div>$/);
  });

  it("uses one minimum width for the primary slot", () => {
    const html = renderToStaticMarkup(<RowActions primary={<button>Plan remediation</button>} slot="11rem" />);
    expect(html).toContain("grid-template-columns:minmax(11rem, max-content) auto auto");
  });
});

describe("Column.fold — a narrow table moves values into another column, never drops them (F6/F20/F21/F25)", () => {
  type R = { id: string };
  const col = (key: string, fold?: { md?: string; sm?: string }) => ({ key, header: key, render: (r: R) => r.id, fold });
  const cols = [col("a"), col("b", { md: "a" }), col("c", { md: "b", sm: "a" }), col("d", { sm: "c" })];
  const hostsAt = (step: "lg" | "md" | "sm") => Object.fromEntries(foldHosts(cols, step));

  it("leaves every column in place on a wide table", () => {
    expect(hostsAt("lg")).toEqual({ a: "a", b: "b", c: "c", d: "d" });
  });

  it("follows a chain to a column that is still shown", () => {
    // md: c names b, which itself folds into a, so c lands in a too; d only folds on a phone
    expect(hostsAt("md")).toEqual({ a: "a", b: "a", c: "a", d: "d" });
  });

  it("falls back to md on a phone, and sm wins where it is set", () => {
    expect(hostsAt("sm")).toEqual({ a: "a", b: "a", c: "a", d: "a" });
  });

  it("keeps a column in place when its fold names no column or loops", () => {
    const loop = [col("x", { md: "y" }), col("y", { md: "x" }), col("z", { md: "nope" })];
    expect(Object.fromEntries(foldHosts(loop, "md"))).toEqual({ x: "x", y: "y", z: "z" });
  });

  it("renders every column, unfolded, where layout is not measured", () => {
    const html = renderToStaticMarkup(<FoldTable<R> columns={cols} rows={[{ id: "r1" }]} rowKey={(r) => r.id} />);
    expect(html.match(/<th[ >]/g)).toHaveLength(4);
    expect(html).not.toContain("data-fold=");
  });
});

describe("Card caption — sits under the title, outside the contained scroll box (F21)", () => {
  it("renders before the contained body, not inside it", () => {
    const html = renderToStaticMarkup(
      <Card title="Inventory" contain caption="Every row is a lead for triage, not a verdict.">
        <p>body</p>
      </Card>,
    );
    const caption = html.indexOf("Every row is a lead");
    expect(caption).toBeGreaterThan(html.indexOf("Inventory"));
    // the caption's paragraph closes before the body's box opens
    expect(html.indexOf("</p>", caption)).toBeLessThan(html.indexOf("<p>body</p>"));
  });
});
