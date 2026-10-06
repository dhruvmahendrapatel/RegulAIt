/**
 * ADR-0182 (ADR-0175 batch D4) A14 — THE ACKNOWLEDGEMENT INTERSTITIAL.
 * OWNER: A14 (D4).
 *
 * Mounted by the app shell (AppShell.tsx, P0's) around every signed-in page.
 * A14 makes it ask a person to acknowledge the current version of each AI
 * policy or training that applies to them (GET /v1/me/ai-literacy) before the
 * page behind it; the gateway enforces the same rule on governed calls.
 *
 * FOUNDATION STUB (P0): renders the page unchanged.
 */
import type { ReactNode } from "react";

export default function AcknowledgeGate(props: { children: ReactNode }) {
  return <>{props.children}</>;
}
