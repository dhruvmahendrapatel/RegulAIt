/**
 * Compliance packs → scorecard → "Tested by" (ADR-0173 batch 2c, item 7).
 *
 * Per control, the evaluators in the evaluator catalog that cite it, and
 * whether a completed run of each PASSED in the scorecard's period. Only a
 * pass counts as tested; "failed" and "not run" are shown as such and never
 * read as passed.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Badge } from "../../../ui/kit";
import v from "../../views.module.css";

export interface TestedByEntry {
  evaluatorId: string;
  kind: string;
  name: string;
  status: "passed" | "failed" | "not_run";
  runs: number;
  passedRuns: number;
}
export interface TestedByResponse {
  controls: Record<string, TestedByEntry[]>;
  period: { start: string; end: string };
  note: string;
}

/** the tested-by map for a pack and period; null while unavailable (e.g. 403) */
export function useTestedBy(packId: string | null, period: { start?: string; end?: string } | null) {
  return useQuery({
    queryKey: ["admin", "eval-tested-by", packId, period?.start, period?.end],
    enabled: Boolean(packId),
    retry: false,
    queryFn: () => {
      const q = new URLSearchParams({ packId: packId! });
      if (period?.start) q.set("from", period.start);
      if (period?.end) q.set("to", period.end);
      return api.get<TestedByResponse>(`/v1/evals/catalog/tested-by?${q.toString()}`);
    },
  });
}

const STATUS_LABEL: Record<TestedByEntry["status"], string> = { passed: "passed", failed: "failed", not_run: "not run" };

export function TestedByChip(props: { controlRef: string; entries: TestedByEntry[] | undefined }) {
  const entries = props.entries ?? [];
  if (entries.length === 0) return <span className={v.faint}>no evaluator</span>;
  const passed = entries.filter((e) => e.status === "passed").length;
  const failed = entries.filter((e) => e.status === "failed").length;
  const tone = passed > 0 ? "ok" : failed > 0 ? "warn" : "neutral";
  return (
    <details data-testid={`tested-by-${props.controlRef}`}>
      <summary style={{ cursor: "pointer" }}>
        <Badge tone={tone}>
          Tested by {passed} of {entries.length}
        </Badge>
      </summary>
      <ul style={{ margin: "var(--s1) 0 0", paddingLeft: "var(--s3)" }}>
        {entries.map((e) => (
          <li key={e.evaluatorId}>
            <code>{e.evaluatorId}</code>{" "}
            <Badge tone={e.status === "passed" ? "ok" : e.status === "failed" ? "warn" : "neutral"}>
              {STATUS_LABEL[e.status]}
            </Badge>{" "}
            <span className={v.faint}>
              {e.runs === 0 ? "no run in the period" : `${e.passedRuns} of ${e.runs} run(s) passed`}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
