/**
 * ADR-0230 (security review #798): the stored `mcp_tools.kind` for a tool on an SAP business server is always 'write',
 * whatever the upstream's `readOnlyHint` (or an admin's POST) says, so every reader of the column (the execution
 * re-check, policy simulation, orchestration, autonomy, the builder) agrees with the proxy. Unmarking leaves the stored
 * kinds at 'write' (the stricter reading) until the next manifest sync restores the upstream's hints. A leaf module
 * (it imports only the schema), so the evaluator, the proxy and the routes can share it without an import cycle.
 */
import { eq, mcpServers, type Db } from "@regulait/db";

export function sapStoredToolKind(systemClass: string | null | undefined, kind: "read" | "write"): "read" | "write" {
  return systemClass === "sap_business" ? "write" : kind;
}

/**
 * The server's system class. With `lock`, the row is read FOR SHARE (code review #798): a manifest sync then waits for
 * a mark in progress (which holds the row FOR UPDATE) and stores the kinds the mark set, instead of racing it.
 */
export async function serverSystemClass(db: Db, serverId: string, opts: { lock?: boolean } = {}): Promise<string | null> {
  const q = db.select({ systemClass: mcpServers.systemClass }).from(mcpServers).where(eq(mcpServers.id, serverId));
  const [row] = opts.lock ? await q.for("share") : await q;
  return row?.systemClass ?? null;
}
