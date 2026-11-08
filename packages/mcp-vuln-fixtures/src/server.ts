/**
 * Serve a fixture over a real MCP transport (TEST ONLY). The low-level SDK `Server` is used on purpose: it returns
 * the manifest exactly as written (no schema conversion, no name validation), which is what an attacker controls.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { listedTools, manifestFor, type FixtureManifest, type VulnerableMcpFixture } from "./fixtures.js";

/** Mutable serving state: which phase is served, and what the server saw (so a test can prove zero calls). */
export interface FixtureState {
  readonly fixture: VulnerableMcpFixture;
  phase: "approved" | "pulled";
  /** every tools/call the server received, by tool name, with its arguments */
  readonly calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** every JSON-RPC method the server received, in order */
  readonly methods: string[];
}

export function fixtureState(fixture: VulnerableMcpFixture): FixtureState {
  return { fixture, phase: "approved", calls: [], methods: [] };
}

/** Switch a rug-pull fixture to its post-approval manifest. */
export function pull(state: FixtureState): void {
  if (!state.fixture.phases.pulled) throw new Error(`fixture '${state.fixture.id}' has no pulled phase`);
  state.phase = "pulled";
}

const current = (state: FixtureState): FixtureManifest => manifestFor(state.fixture, state.phase);

/** One MCP server instance answering from the state (a new one per HTTP request in stateless mode). */
export function createFixtureServer(state: FixtureState): Server {
  const manifest = current(state);
  const hasPrompts = (manifest.prompts?.length ?? 0) > 0;
  const hasResources = (manifest.resources?.length ?? 0) > 0;
  const server = new Server(
    { name: `regulait-vuln-fixture-${state.fixture.id}`, version: "1.0.0" },
    { capabilities: { tools: {}, ...(hasPrompts ? { prompts: {} } : {}), ...(hasResources ? { resources: {} } : {}) } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    state.methods.push("tools/list");
    return { tools: listedTools(current(state)) as never };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    state.methods.push("tools/call");
    state.calls.push({ name: req.params.name, arguments: (req.params.arguments ?? {}) as Record<string, unknown> });
    const tool = current(state).tools.find((t) => t.name === req.params.name);
    if (!tool) return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
    return { content: [{ type: "text", text: tool.returns ?? "ok" }] };
  });
  if (hasPrompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      state.methods.push("prompts/list");
      return { prompts: (current(state).prompts ?? []).map(({ text: _text, ...p }) => p) };
    });
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      state.methods.push("prompts/get");
      const p = (current(state).prompts ?? []).find((x) => x.name === req.params.name);
      return { messages: [{ role: "user", content: { type: "text", text: p?.text ?? "" } }] };
    });
  }
  if (hasResources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      state.methods.push("resources/list");
      return { resources: (current(state).resources ?? []).map(({ text: _text, ...r }) => r) };
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      state.methods.push("resources/templates/list");
      return { resourceTemplates: [] };
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      state.methods.push("resources/read");
      const r = (current(state).resources ?? []).find((x) => x.uri === req.params.uri);
      return { contents: r ? [{ uri: r.uri, mimeType: r.mimeType, text: r.text }] : [] };
    });
  }
  return server;
}

export interface ServedFixture {
  state: FixtureState;
  url: string;
  port: number;
  /** HTTP requests received (each JSON-RPC message is one request in stateless mode) */
  requests(): number;
  close(): Promise<void>;
}

/** Serve a fixture on 127.0.0.1 over stateless Streamable HTTP. */
export async function serveFixtureOverHttp(fixture: VulnerableMcpFixture | FixtureState): Promise<ServedFixture> {
  const state = "fixture" in fixture ? fixture : fixtureState(fixture);
  let requests = 0;
  const httpServer = http.createServer((req, res) => {
    requests++;
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      void (async () => {
        const message = body ? (JSON.parse(body) as unknown) : undefined;
        const server = createFixtureServer(state);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, message);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  let closed = false;
  return {
    state,
    url: `http://127.0.0.1:${port}/`,
    port,
    requests: () => requests,
    close: async () => {
      if (closed) return;
      closed = true;
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
