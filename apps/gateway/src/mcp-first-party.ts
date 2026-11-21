/**
 * ADR-0364 (lane E45 S2) — FIRST-PARTY MCP SERVERS, served in-process.
 *
 * A `first_party` row (`mcp_servers.transport`) is a server the gateway itself implements; its URL is a fixed
 * `regulait:<name>` key (a database CHECK ties the transport to that URL shape, and a unique index allows one row
 * per key). `guardedMcpConnect` opens it here, over the SDK's linked in-memory transport, so nothing leaves the
 * process. Only a key on this fixed list is served: any other `regulait:` row (or a `first_party` row reaching the
 * remote-egress path) is refused, fail closed.
 *
 * first_party is NOT one of the org's enable-able upstream transports (`mcp_upstream_transports`): no setting turns
 * it on or off, and no admin can register a row with it (the registration and update routes accept only the
 * upstream transports). The one row is seeded by the migration.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Db } from "@regulait/db";
import { createRobotsMcpServer, ROBOTS_SERVER_URL } from "./robots-mcp.js";

const FIRST_PARTY_SERVERS: ReadonlyMap<string, (db: Db, serverId: string) => Server> = new Map([
  [ROBOTS_SERVER_URL, createRobotsMcpServer],
]);

export function isFirstPartyServerUrl(url: string): boolean {
  return FIRST_PARTY_SERVERS.has(url);
}

/** open a client session to the in-process server named by `url`; null = not a first-party server we serve */
export async function connectFirstPartyServer(db: Db, row: { id: string; url: string }, deadlineMs: number): Promise<Client | null> {
  const factory = FIRST_PARTY_SERVERS.get(row.url);
  if (!factory) return null;
  const server = factory(db, row.id);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "regulait-gateway", version: "0.1.0" });
  // closing the client ends the server's session too, so a governed call leaves nothing open
  const close = client.close.bind(client);
  client.close = async () => {
    await close();
    await server.close().catch(() => {});
  };
  await client.connect(clientSide, { timeout: deadlineMs });
  return client;
}
