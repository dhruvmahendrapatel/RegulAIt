/**
 * ADR-0346 decision 7 — a LEAF module (it imports only @regulait/db): the SQL condition that a model card holds
 * MEASURED fairness evidence. Read by the ADR-0150 compliance-pack collector, which must not import the signing
 * half of fairness-evaluation.ts (that would close an import cycle through decision-receipts.ts).
 */
import { fairnessRunEvidence, fairnessRuns, modelCards, sql } from "@regulait/db";

/**
 * ADR-0346 decision 7: the SQL condition, over `model_cards`, that a card holds MEASURED fairness evidence: its latest
 * fairness run (supplied or model) passed, was made on the card's current model version, and has signed evidence.
 * An older pass never outvotes a newer failure.
 */
export function fairnessCardMeasuredSql() {
  return sql`EXISTS (
    SELECT 1 FROM ${fairnessRuns} fr
    JOIN ${fairnessRunEvidence} fe ON fe.run_id = fr.id
    WHERE fr.card_id = ${modelCards.id}
      AND fr.outcome = 'pass'
      AND fr.card_model_version IS NOT DISTINCT FROM ${modelCards.pinnedModelVersion}
      AND fr.created_at = (SELECT max(f2.created_at) FROM ${fairnessRuns} f2 WHERE f2.card_id = ${modelCards.id})
  )`;
}

