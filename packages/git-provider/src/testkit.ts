// Test-only fake upstream: a real node:http server the adapters hit through
// the global fetch, following the repo's fake-upstream e2e pattern. Named
// testkit.ts (not *.test.ts) so vitest does not collect it as a suite; it is
// deliberately NOT exported from index.ts.

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  /** path + query, e.g. "/projects/a%2Fb/merge_requests?x=1" */
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export type FakeResponse = { status: number; body: unknown };
export type Responder = FakeResponse | ((req: RecordedRequest) => FakeResponse);

export class FakeUpstream {
  readonly requests: RecordedRequest[] = [];
  baseUrl = "";
  private readonly routes = new Map<string, Responder>();
  private server: http.Server | null = null;

  /** register a responder for `${method} ${pathWithQuery}` (exact match) */
  route(method: string, url: string, responder: Responder): void {
    this.routes.set(`${method} ${url}`, responder);
  }

  reset(): void {
    this.routes.clear();
    this.requests.length = 0;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown;
        if (raw) {
          try {
            body = JSON.parse(raw) as unknown;
          } catch {
            body = raw;
          }
        }
        const rec: RecordedRequest = {
          method: req.method ?? "GET",
          url: req.url ?? "",
          headers: req.headers,
          body,
        };
        this.requests.push(rec);
        const responder = this.routes.get(`${rec.method} ${rec.url}`);
        if (!responder) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `no fake route for '${rec.method} ${rec.url}'` }));
          return;
        }
        const out = typeof responder === "function" ? responder(rec) : responder;
        if (typeof out.body === "string") {
          // string bodies go out raw (e.g. ADO's HTML sign-in page)
          res.writeHead(out.status, { "content-type": "text/html" });
          res.end(out.body);
        } else {
          res.writeHead(out.status, { "content-type": "application/json" });
          res.end(JSON.stringify(out.body));
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }
}
