/**
 * ADR-0187 — an engine's state as one badge, for the Engines page and any run
 * surface that names an engine. The words carry the state (axe: no colour-only
 * distinction); only an enabled engine with a fresh passing self-test is green.
 */
import { Badge } from "../../../ui/kit";
import { engineHealth } from "./engineModel";
import type { Engine } from "./engineTypes";

export function EngineStatusBadge(props: { engine: Engine; now?: number }) {
  const h = engineHealth(props.engine, props.now ?? Date.now());
  return (
    <Badge tone={h.tone} title={h.detail}>
      {h.label}
    </Badge>
  );
}
