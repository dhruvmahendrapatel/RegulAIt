/**
 * ADR-0180 §6 (A10) — the admin's risk tolerance editor.
 *
 * Strict by default: with nothing configured, residual risk above medium
 * needs a valid, time-limited acceptance. An admin may set a different
 * tolerance per risk category or per review tier. A risk's tolerance is the
 * stricter of its category's and its tier's, and a scope with no row counts at
 * the strict default, so relaxing one scope never relaxes another. Saving replaces the whole configured set and is audited
 * with the old and new values (`PUT /v1/risk-tolerances`).
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { humanize } from "../../../api/format";
import { Badge, Button, Card, Select, Table } from "../../../ui/kit";
import { QueryGate, useAction } from "../adminKit";
import v from "../../views.module.css";

type ScopeKind = "category" | "tier";
interface TolerancesView {
  source: "default" | "configured";
  strictDefault: { maxBand: string };
  tolerances: Array<{ scopeKind: ScopeKind; scopeKey: string; maxBand: string; relaxed: boolean }>;
  effective: {
    categories: Record<string, { maxBand: string; source: "default" | "configured" }>;
    tiers: Record<string, { maxBand: string; source: "default" | "configured" }>;
  };
  bands: string[];
}

const BAND_TEXT: Record<string, string> = {
  none: "none: every residual risk needs an acceptance",
  low: "up to low",
  medium: "up to medium (strict default)",
  high: "up to high",
  critical: "up to critical (never needs an acceptance)",
};

interface Row {
  key: string;
  kind: ScopeKind;
  scopeKey: string;
}

/** A response of the wrong shape (an older gateway, a proxy error page) becomes a
 * retryable error in the card, never a render crash that unmounts the whole app. */
function assertTolerancesView(x: unknown): TolerancesView {
  const v = x as Partial<TolerancesView> | null;
  const ok =
    !!v &&
    Array.isArray(v.tolerances) &&
    Array.isArray(v.bands) &&
    !!v.effective &&
    typeof v.effective.categories === "object" &&
    v.effective.categories !== null &&
    typeof v.effective.tiers === "object" &&
    v.effective.tiers !== null;
  if (!ok) throw new Error("The risk-tolerance settings came back in an unexpected form. Retry, or check the gateway version.");
  return v as TolerancesView;
}

export function RiskTolerancePanel() {
  const act = useAction();
  const q = useQuery({
    queryKey: ["admin", "risk-tolerances"],
    queryFn: async () => assertTolerancesView(await api.get<unknown>("/v1/risk-tolerances")),
  });
  // "" = no row: the strict default applies
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!q.data) return;
    setDraft(Object.fromEntries(q.data.tolerances.map((t) => [`${t.scopeKind}:${t.scopeKey}`, t.maxBand])));
  }, [q.data]);
  const d = q.data;
  const rows: Row[] = d
    ? [
        ...Object.keys(d.effective.categories).map((k) => ({ key: `category:${k}`, kind: "category" as const, scopeKey: k })),
        ...Object.keys(d.effective.tiers).map((k) => ({ key: `tier:${k}`, kind: "tier" as const, scopeKey: k })),
      ]
    : [];
  const configured = (d?.tolerances ?? []).map((t) => `${t.scopeKind}:${t.scopeKey}=${t.maxBand}`).sort().join(",");
  const drafted = Object.entries(draft)
    .filter(([, b]) => b)
    .map(([k, b]) => `${k}=${b}`)
    .sort()
    .join(",");
  const dirty = configured !== drafted;

  const save = () =>
    void act.run(async () => {
      await api.put("/v1/risk-tolerances", {
        tolerances: Object.entries(draft)
          .filter(([, b]) => b)
          .map(([k, maxBand]) => {
            const [scopeKind, scopeKey] = k.split(":") as [ScopeKind, string];
            return { scopeKind, scopeKey, maxBand };
          }),
      });
      await q.refetch();
    }, "Risk tolerances saved. The change is recorded in the audit trail.");

  return (
    <Card
      title="Risk tolerance (admin)"
      actions={d ? <Badge tone={d.source === "default" ? "ok" : "warn"}>{d.source === "default" ? "strict default" : "configured"}</Badge> : null}
    >
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {d && (
          <div className={v.stack}>
            <p className={v.hint}>
              With nothing configured, any residual risk above {d.strictDefault.maxBand} needs a valid, time-limited
              acceptance. You can set a different tolerance for a risk category or a review tier. A risk gets the
              stricter of its category&apos;s and its tier&apos;s tolerance, and one you have not set counts as{" "}
              {d.strictDefault.maxBand}, so relaxing a risk needs both its category and its tier relaxed. Relaxing a
              tolerance is recorded in the audit trail.
            </p>
            <Table
              rows={rows}
              rowKey={(r) => r.key}
              columns={[
                { key: "scope", header: "Applies to", render: (r) => `${r.kind === "category" ? "Category" : "Tier"}: ${humanize(r.scopeKey)}` },
                {
                  key: "now",
                  header: "In force",
                  render: (r) => {
                    const e = r.kind === "category" ? d.effective.categories[r.scopeKey]! : d.effective.tiers[r.scopeKey]!;
                    return (
                      <span>
                        {`up to ${e.maxBand}`} <span className={v.faint}>({e.source === "default" ? "default" : "configured"})</span>
                      </span>
                    );
                  },
                },
                {
                  key: "set",
                  header: "Set to",
                  render: (r) => (
                    <Select
                      aria-label={`Tolerance for ${r.kind} ${humanize(r.scopeKey)}`}
                      value={draft[r.key] ?? ""}
                      onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })}
                    >
                      <option value="">use the strict default</option>
                      {d.bands.map((b) => (
                        <option key={b} value={b}>
                          {BAND_TEXT[b] ?? b}
                        </option>
                      ))}
                    </Select>
                  ),
                },
              ]}
            />
            <div>
              <Button disabled={act.busy || !dirty} onClick={save}>
                Save risk tolerances
              </Button>{" "}
              <Button variant="ghost" disabled={act.busy || Object.values(draft).every((b) => !b)} onClick={() => setDraft({})}>
                Clear all (back to the strict default)
              </Button>
            </div>
          </div>
        )}
      </QueryGate>
    </Card>
  );
}
