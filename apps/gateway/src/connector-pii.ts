import type { ConnectorInvocation } from "@regulait/connector-provider";
import { preparePiiApproval, type InternationalPiiCategory } from "@regulait/shared";

/** Connector routing is an authorization identity, never a redaction target. */
export function prepareConnectorPiiAction(
  projectId: string | null,
  invocation: ConnectorInvocation,
  international: readonly InternationalPiiCategory[],
) {
  const prepared = preparePiiApproval({ projectId, arguments: {
    operation: invocation.operation, object: invocation.object ?? null, payload: invocation.payload ?? null,
  } }, international);
  const effective = prepared.effectiveArguments;
  if (effective.object !== (invocation.object ?? null) || effective.operation !== invocation.operation) {
    throw new Error("Connector routing identity cannot be redacted");
  }
  return { prepared, invocation: effective as unknown as ConnectorInvocation };
}

export class ConnectorPolicyChangedError extends Error {
  constructor() { super("Connector policy changed; fresh admission is required"); }
}
