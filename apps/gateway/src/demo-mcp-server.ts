/**
 * A REAL MCP server for the demo, on loopback.
 *
 * WHY THIS EXISTS. `seed.ts` registers its two MCP servers against
 * `http://127.0.0.1:9/` — the discard port — deliberately, so that seeding
 * needs no listener and no network. That is right for a seeded playground and
 * wrong for a live demo: `POST /mcp/:serverId` connects upstream at the TOP of
 * the handler, before any JSON-RPC message is read, so that egress and
 * admission refusals come back as plain HTTP rather than as protocol errors.
 * Against the discard port every request therefore dies at connect — including
 * `initialize` — and the gateway looks broken rather than governed.
 *
 * So: a real Streamable HTTP MCP server, serving the two paths the seed
 * registers, with the EXACT tool names and read/write classification the
 * seeded grants, revocations and approval rules are keyed on.
 *
 * THREE THINGS HERE ARE LOAD-BEARING AND EASY TO BREAK:
 *
 *  1. `annotations.readOnlyHint` IS the read/write classification. The gateway
 *     upserts the live manifest over the seeded inventory on every connect, so
 *     a tool that loses its hint is silently RE-CLASSIFIED as a write — and
 *     the demo's "read allowed, write needs approval" story inverts.
 *  2. The paths are answered EXACTLY. The gateway's guarded fetch uses
 *     `redirect: "manual"` and treats any 3xx as an egress failure, so a
 *     helpful trailing-slash redirect would break the demo in a way that reads
 *     as a governance refusal.
 *  3. It binds 127.0.0.1 as an IP LITERAL. The egress guard blocks the
 *     hostname `localhost` outright; loopback by address is permitted with no
 *     ceremony under the default private-ranges posture.
 *
 * This is a demo double. It holds nothing, authenticates nobody, and every
 * answer is fabricated — the point is to exercise the GOVERNANCE path with a
 * real protocol on the wire, not to be a useful tool server.
 *
 *   pnpm --filter @regulait/gateway demo:mcp   [-- --port 8931]
 *
 * Under `docker compose`, the gateway's own 127.0.0.1 is the container, not
 * your host, so a host-run copy of this is unreachable from it. Run the
 * gateway on the host for the demo, or put this on the compose network and
 * point the server rows at its service name.
 */
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

interface DemoTool {
  name: string;
  read: boolean;
  description: string;
  input: Record<string, z.ZodTypeAny>;
  run: (args: Record<string, string>) => string;
}
interface ServerSpec {
  name: string;
  tools: DemoTool[];
}

const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const PORT = Number(
  portArg !== -1 ? argv[portArg + 1] : (process.env.REGULAIT_DEMO_MCP_PORT ?? 8931),
);

/**
 * The two servers the seed registers, keyed by the path in `mcp_servers.url`.
 * `read: true` becomes `annotations.readOnlyHint` — see note 1 above.
 */
/**
 * EACH SERVER GETS ITS OWN LOOPBACK ADDRESS, and that is not fussiness.
 *
 * MCP discovery (ADR-0122) diffs supplied evidence against the registry BY
 * HOST, so two servers sharing one host collapse onto whichever registry row
 * the select returned last — a limit the ADR discloses, and a real one: the
 * deployment genuinely cannot tell them apart. On a demo it reads as a bug,
 * because evidence naming `/repo-mcp` comes back attributed to the warehouse.
 * 127.0.0.0/8 is entirely loopback, so giving each its own address costs
 * nothing, keeps the diff honest, and makes the registry count read as 2.
 */
const HOSTS = ["127.0.0.1", "127.0.0.2"] as const;

const SERVERS: Record<string, ServerSpec> = {
  "/repo-mcp": {
    name: "repo-tools",
    tools: [
      { name: "read_file", read: true, description: "read one file at a ref",
        input: { path: z.string(), ref: z.string().optional() },
        run: (a: Record<string, string>) => `// ${a.path} @ ${a.ref ?? "main"}\nexport function checkout() { /* ... */ }` },
      { name: "search_code", read: true, description: "regex search across the repository",
        input: { pattern: z.string() },
        run: (a: Record<string, string>) => `3 matches for /${a.pattern}/\n  src/checkout/vault.ts:41\n  src/checkout/index.ts:12\n  test/vault.test.ts:88` },
      { name: "list_branches", read: true, description: "list branches and their heads",
        input: {},
        run: () => "main            a1b2c3d\nfeat/vault      9f8e7d6\nrelease/2026-09 4c5d6e7" },
      // NO readOnlyHint — these must classify as WRITES, which is what makes
      // the seeded approval rule on write_file fire.
      { name: "write_file", read: false, description: "commit a file change to a branch",
        input: { path: z.string(), content: z.string(), branch: z.string().optional() },
        run: (a: Record<string, string>) => `committed ${a.path} (${String(a.content ?? "").length} bytes) to ${a.branch ?? "main"} as commit demo01a` },
      { name: "delete_branch", read: false, description: "delete a branch (destructive)",
        input: { branch: z.string() },
        run: (a: Record<string, string>) => `deleted branch ${a.branch}` },
    ],
  },
  "/warehouse-mcp": {
    name: "data-warehouse",
    tools: [
      { name: "list_schemas", read: true, description: "list schemas visible to the connection",
        input: {},
        run: () => "ANALYTICS\nBILLING\nONCOLOGY_PHI\nRAW" },
      { name: "query", read: true, description: "run a read-only SQL query against a schema",
        input: { sql: z.string() },
        run: (a: Record<string, string>) => `-- ${a.sql}\nREGION | ORDERS | REVENUE_USD\nNA     |  18422 |   4821900\nEMEA   |   9130 |   2214050` },
      { name: "export_table", read: false, description: "materialize a table to object storage",
        input: { table: z.string(), destination: z.string().optional() },
        run: (a: Record<string, string>) => `exported ${a.table} to ${a.destination ?? "s3://demo-exports/"} (12 parts)` },
    ],
  },
};

function buildServer(spec: ServerSpec) {
  const server = new McpServer({ name: spec.name, version: "0.0.1-demo" });
  for (const tool of spec.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        // See note 1: the presence of this hint is the classification.
        ...(tool.read ? { annotations: { readOnlyHint: true } } : {}),
      },
      async (args: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: String(tool.run((args ?? {}) as Record<string, string>)) }],
      }),
    );
  }
  return server;
}

const handleRequest: http.RequestListener = (req, res) => {
  // Exact match only — see note 2. An unknown path is a 404, never a redirect.
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const spec = SERVERS[pathname];
  if (!spec) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "unknown_path",
        detail: `this demo server answers exactly ${Object.keys(SERVERS).join(" and ")} — and answers nothing else, deliberately, because a redirect here would surface as an egress failure`,
      }),
    );
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    void (async () => {
      // Fresh server + stateless transport per request, exactly as the
      // gateway's own suite drives its upstreams: the gateway builds a new
      // client per connect, so there is no session to keep.
      const server = buildServer(spec);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    })().catch((err: Error) => {
      process.stderr.write(`[demo-mcp] ${pathname}: ${err?.message ?? String(err)}\n`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
};

/**
 * ONE LISTENER PER LOOPBACK ADDRESS, each built from the same handler.
 *
 * Every listener gets its own `error` handler: the first version of this
 * shared one server object and cloned its request listener, and when the
 * second bind failed the process printed NOTHING and exited silently — a
 * start-up failure that looks exactly like a slow start is the last thing you
 * want ten minutes before a demo.
 */
const listeners = HOSTS.map((host) => {
  const server = http.createServer(handleRequest);
  server.on("error", (err: NodeJS.ErrnoException) => {
    process.stderr.write(
      `\n  demo MCP server could NOT bind ${host}:${PORT} — ${err.code ?? err.message}\n` +
        (err.code === "EADDRINUSE"
          ? "  Something is already on that port. Stop it, or pass --port.\n\n"
          : "\n"),
    );
    process.exit(1);
  });
  return { host, server };
});

let listening = 0;
for (const { host, server } of listeners) {
  server.listen(PORT, host, () => {
    listening += 1;
    if (listening < listeners.length) return;
    const entries = Object.entries(SERVERS);
    process.stdout.write(
      [
        "",
        "  RegulAIt demo MCP server — a demo double, holding nothing, on loopback.",
        "",
        ...entries.map(([routePath, spec], i) => {
          const boundHost = HOSTS[Math.min(i, HOSTS.length - 1)];
          return (
            `    ${spec.name.padEnd(16)} http://${boundHost}:${PORT}${routePath}   ${spec.tools.length} tools ` +
            `(${spec.tools.filter((t) => t.read).length} read, ${spec.tools.filter((t) => !t.read).length} write)`
          );
        }),
        "",
        "  Every path is served on BOTH addresses; the setup script registers each",
        "  server against its own, so ADR-0122's host-keyed registry diff names the",
        "  right one instead of collapsing them.",
        "",
        "  Register them with:  pnpm --filter @regulait/gateway demo:setup",
        "  Leave this running for the whole demo. Ctrl-C to stop.",
        "",
      ].join("\n"),
    );
  });
}
