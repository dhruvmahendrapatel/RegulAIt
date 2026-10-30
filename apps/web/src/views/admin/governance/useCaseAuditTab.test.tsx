/**
 * #465 review L2 — the use-case Audit tab offers the full audit trail link only to an admin. The audit log is an
 * admin surface (the gateway refuses `/v1/audit` to anyone else), so a non-admin is told who holds the full trail
 * instead of being sent to a 403. Rendered with react-dom/server (no DOM, no network).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuditTab } from "./UseCaseOverviewPage";

const ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const rows = [{ id: 1, at: "2026-10-20T10:00:00.000Z", userId: null, ruleId: "use-case-registered", effect: "allow", reason: "registered" }];

const render = (isAdmin: boolean) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AuditTab rows={rows as never} total={1} useCaseId={ID} isAdmin={isAdmin} />
    </MemoryRouter>,
  );

describe("use-case Audit tab, full-trail link (#465 L2)", () => {
  it("links an admin to this use case's own trail", () => {
    const html = render(true);
    expect(html).toContain(`href="/admin/audit?objectType=ai_use_case&amp;objectId=${ID}"`);
    expect(html).toContain("View all of this use case&#x27;s audit trail");
    expect(html).toContain("View all →");
    expect(html).not.toContain("use-case-audit-admin-only");
  });

  it("is a preview: at most five rows, with the count of every row", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...rows[0], id: i + 1 }));
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AuditTab rows={many as never} total={57} useCaseId={ID} isAdmin />
      </MemoryRouter>,
    );
    expect(html.match(/<tr>/g)?.length).toBe(1 + 5);
    expect(html).toContain("Showing the newest 5 of 57 rows.");
    const capped = renderToStaticMarkup(
      <MemoryRouter>
        <AuditTab rows={many as never} total={undefined} useCaseId={ID} isAdmin />
      </MemoryRouter>,
    );
    expect(capped).toContain("Showing the newest 5 of 20+ rows.");
  });

  it("tells a non-admin the full trail needs an administrator, with no link into the audit log", () => {
    const html = render(false);
    expect(html).not.toContain("/admin/audit");
    expect(html).toContain('data-testid="use-case-audit-admin-only"');
    expect(html).toContain("open to administrators");
  });
});
