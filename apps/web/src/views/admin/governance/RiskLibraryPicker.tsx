import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SCENARIO_LIBRARY, type DemoRiskScenario } from "@regulait/shared";
import { ApiError, api } from "../../../api/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select } from "../../../ui/kit";
import { QueryGate, optionEls, useAction } from "../adminKit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";

type RiskRating = "low" | "medium" | "high";

export function RiskLibraryPicker(props: { useCaseId?: string; agentId?: string; onAdded?: () => void }) {
  const library = useQuery({
    queryKey: ["admin", "risk-library"],
    queryFn: () => api.get<{ library: DemoRiskScenario[]; disclaimer: string }>("/v1/risks/library"),
  });
  const action = useAction();
  const [search, setSearch] = useState("");
  const [dimension, setDimension] = useState("");
  const [domain, setDomain] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [likelihood, setLikelihood] = useState<RiskRating | "">("");
  const [impact, setImpact] = useState<RiskRating | "">("");

  const normalized = useMemo(() => SCENARIO_LIBRARY, []);
  const dimensions = [...new Set(normalized.map((entry) => entry.dimension))].sort();
  const domains = [...new Set(normalized.flatMap((entry) => entry.domains))].sort();
  const needle = search.trim().toLowerCase();
  const filtered = normalized.filter((entry) =>
    (!needle || `${entry.title} ${entry.description} ${entry.category}`.toLowerCase().includes(needle)) &&
    (!dimension || entry.dimension === dimension) &&
    (!domain || entry.domains.includes(domain)),
  );

  const choose = (key: string) => {
    setSelectedKey(key);
    setLikelihood("");
    setImpact("");
  };

  const add = (entry: (typeof normalized)[number]) => {
    if (!likelihood || !impact) return;
    return action.run(async () => {
      const risk = await api.post<{ id: string }>("/v1/risks", {
        title: entry.title,
        description: entry.description,
        category: entry.category,
        likelihood,
        impact,
        ...(props.useCaseId ? { useCaseId: props.useCaseId } : {}),
        ...(props.agentId ? { agentId: props.agentId } : {}),
      });
      for (const controlRef of entry.suggestedControls) {
        try {
          await api.post(`/v1/risks/${risk.id}/controls`, { controlRef });
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error;
        }
      }
      props.onAdded?.();
      setSelectedKey(null);
      setLikelihood("");
      setImpact("");
    }, `Risk added from “${entry.title}”${entry.suggestedControls.length > 0 ? " with its suggested controls" : ""}`);
  };

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
                  {selectedKey === entry.key ? (
                    <div className={s.libraryAssessment}>
                      <p className={v.dim}>Assess this risk for the selected use case. The library does not assign likelihood or impact.</p>
                      <Field label="Likelihood">
                        <Select value={likelihood} onChange={(event) => setLikelihood(event.target.value as RiskRating | "")}>
                          {optionEls([
                            { v: "low", l: "Low" },
                            { v: "medium", l: "Medium" },
                            { v: "high", l: "High" },
                          ], "Choose likelihood")}
                        </Select>
                      </Field>
                      <Field label="Impact">
                        <Select value={impact} onChange={(event) => setImpact(event.target.value as RiskRating | "")}>
                          {optionEls([
                            { v: "low", l: "Low" },
                            { v: "medium", l: "Medium" },
                            { v: "high", l: "High" },
                          ], "Choose impact")}
                        </Select>
                      </Field>
                      <div className={v.row}>
                        <Button size="sm" variant="primary" disabled={action.busy || !likelihood || !impact} onClick={() => void add(entry)}>Add assessed risk</Button>
                        <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => setSelectedKey(null)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" disabled={action.busy} onClick={() => choose(entry.key)}>Assess and add</Button>
                  )}
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
