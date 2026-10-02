import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select } from "../../../ui/kit";
import { QueryGate, optionEls, useAction } from "../adminKit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";
// The demo scenario library is pure, reviewed product data. The web package
// consumes the source directly because it intentionally has no runtime
// dependency on @regulait/shared; Vite bundles this readonly array at build
// time while POST/links still go through the live gateway contracts.
import { SCENARIO_LIBRARY } from "../../../../../../packages/shared/src/demo-intake/scenario-library";

export interface RiskScenario {
  key: string;
  title: string;
  description: string;
  category: string;
  dimension?: string;
  domains?: string[];
  likelihood?: "low" | "medium" | "high";
  impact?: "low" | "medium" | "high";
  suggestedControls?: string[];
  mitigatingControl?: string;
}

const DIMENSION_BY_CATEGORY: Record<string, string> = {
  bias_fairness: "bias",
  prompt_injection: "security",
  data_leakage_pii: "privacy",
  tool_misuse: "security",
  over_permissioning: "security",
  hallucination: "reliability",
  scope_drift: "reliability",
  budget_overrun: "reliability",
  unsafe_output: "safety",
  shadow_ai: "compliance",
  third_party_ai: "compliance",
};

export function RiskLibraryPicker(props: { useCaseId?: string; agentId?: string; onAdded?: () => void }) {
  const library = useQuery({
    queryKey: ["admin", "risk-library"],
    queryFn: () => api.get<{ library: RiskScenario[]; disclaimer: string }>("/v1/risks/library"),
  });
  const action = useAction();
  const [search, setSearch] = useState("");
  const [dimension, setDimension] = useState("");
  const [domain, setDomain] = useState("");

  const normalized = useMemo(() => (SCENARIO_LIBRARY as RiskScenario[]).map((entry) => ({
    ...entry,
    dimension: entry.dimension ?? DIMENSION_BY_CATEGORY[entry.category] ?? "compliance",
    domains: entry.domains?.length ? entry.domains : ["general"],
  })), []);
  const dimensions = [...new Set(normalized.map((entry) => entry.dimension))].sort();
  const domains = [...new Set(normalized.flatMap((entry) => entry.domains))].sort();
  const needle = search.trim().toLowerCase();
  const filtered = normalized.filter((entry) =>
    (!needle || `${entry.title} ${entry.description} ${entry.category}`.toLowerCase().includes(needle)) &&
    (!dimension || entry.dimension === dimension) &&
    (!domain || entry.domains.includes(domain)),
  );

  const add = (entry: (typeof normalized)[number]) => action.run(async () => {
    const risk = await api.post<{ id: string }>("/v1/risks", {
      title: entry.title,
      description: entry.description,
      category: entry.category,
      likelihood: entry.likelihood ?? "medium",
      impact: entry.impact ?? "high",
      ...(entry.mitigatingControl ? { mitigation: entry.mitigatingControl } : {}),
      ...(props.useCaseId ? { useCaseId: props.useCaseId } : {}),
      ...(props.agentId ? { agentId: props.agentId } : {}),
    });
    for (const controlRef of entry.suggestedControls ?? []) {
      try {
        await api.post(`/v1/risks/${risk.id}/controls`, { controlRef });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
      }
    }
    props.onAdded?.();
  }, `Risk added from “${entry.title}”${(entry.suggestedControls?.length ?? 0) > 0 ? " with its suggested controls" : ""}`);

  return (
    <Card title="Add risk from library">
      <QueryGate loading={library.isLoading} error={library.error} onRetry={() => void library.refetch()}>
        <div className={v.stack}>
          <div className={s.libraryFilters}>
            <Field label="Search scenarios"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="prompt injection, runaway loop…" /></Field>
            <Field label="Trust dimension"><Select value={dimension} onChange={(event) => setDimension(event.target.value)}>{optionEls(dimensions.map((value) => ({ v: value, l: value })), "all dimensions")}</Select></Field>
            <Field label="Domain"><Select value={domain} onChange={(event) => setDomain(event.target.value)}>{optionEls(domains.map((value) => ({ v: value, l: value.replace(/-/g, " ") })), "all domains")}</Select></Field>
          </div>
          {filtered.length === 0 ? <EmptyState title="No matching scenarios" body="Clear a filter or try a broader mechanism." /> : (
            <div className={s.libraryList}>
              {filtered.map((entry) => (
                <article key={entry.key} className={s.libraryEntry}>
                  <div className={v.row}><strong>{entry.title}</strong><span className={v.grow} /><Badge tone="info">{entry.dimension}</Badge><Badge tone="neutral">{entry.category.replace(/_/g, " ")}</Badge></div>
                  <p className={v.dim}>{entry.description}</p>
                  <p className={v.faint}>Domains: {entry.domains.join(", ")} · Suggested controls: {entry.suggestedControls?.length ? entry.suggestedControls.join(", ") : "not supplied by this catalog entry"}</p>
                  <Button size="sm" disabled={action.busy} onClick={() => void add(entry)}>Add risk</Button>
                </article>
              ))}
            </div>
          )}
          <p className={v.faint}>{library.data?.disclaimer}</p>
        </div>
      </QueryGate>
    </Card>
  );
}
