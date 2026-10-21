import type { CheckResult, WorkflowDetailResponse } from "../../api/types";

/** the parts of a workflow instance that MergeGateEvidence shows: latest artifacts, PR/branch, checks, dry-run deploys */
export function mergeGateParts(inst: WorkflowDetailResponse) {
  const ctx = inst.instance.context ?? {};
  const latest: Record<string, { id: string; output: string; version: number; content: string }> = {};
  for (const art of inst.artifacts ?? []) {
    if (!latest[art.output] || art.version > latest[art.output]!.version) latest[art.output] = art;
  }
  const checkRows: CheckResult[] = Object.keys(ctx)
    .filter((k) => k.startsWith("checks:"))
    .flatMap((k) => (Array.isArray(ctx[k]) ? (ctx[k] as CheckResult[]) : []));
  const deploys = Object.keys(ctx)
    .filter((k) => k.startsWith("deploy:"))
    .map((k) => ctx[k] as { dryRun?: boolean });
  const prUrl = typeof ctx.prUrl === "string" ? ctx.prUrl : null;
  const branch = typeof ctx.branch === "string" ? ctx.branch : null;
  const hasPrRow = Boolean(prUrl || branch || (ctx.prId != null && (prUrl !== null || branch !== null)));
  const hasEvidence =
    Object.keys(latest).length > 0 || hasPrRow || checkRows.length > 0 || deploys.some((d) => d?.dryRun);
  return { ctx, latest, checkRows, deploys, prUrl, branch, hasPrRow, hasEvidence };
}

/**
 * What the Inbox drawer body says about evidence (owner decision 4 on #453, and the #460 delta review Low):
 * "none" whenever nothing would render, "failed" when the instance read failed (never claimed as "no evidence"),
 * "loading" while a fetched instance is on its way, "shown" when something renders.
 */
export type EvidenceState = "shown" | "none" | "loading" | "failed";

export function drawerEvidenceState(args: {
  toolCall: boolean;
  contextConflict: boolean;
  /** the item has an instance the Inbox fetches (a workflow item with an instanceId) */
  fetched: boolean;
  inst: WorkflowDetailResponse | undefined;
  failed: boolean;
}): EvidenceState {
  if (args.toolCall || args.contextConflict) return "shown";
  if (args.inst) return mergeGateParts(args.inst).hasEvidence ? "shown" : "none";
  if (args.fetched) return args.failed ? "failed" : "loading";
  return "none";
}
