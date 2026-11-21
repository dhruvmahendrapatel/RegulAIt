#!/usr/bin/env node
/**
 * ADR-0343 slice 3: the database WRITER ENDPOINT of the failover suite.
 *
 * In production the writer endpoint is a DNS name or a Service: the RDS endpoint, the Azure FQDN, the Cloud SQL
 * private IP, or CloudNativePG's `<cluster>-rw` Service. Each one follows the primary through a failover. This TCP
 * proxy plays that part. Gateways connect to it, the suite repoints it at the promoted standby, and repointing cuts
 * every open connection, as a dead primary does.
 *
 *   node writer-proxy.mjs --listen 127.0.0.1:15432 --control 127.0.0.1:15499 --target 127.0.0.1:25432
 *
 * Control (loopback only): `PUT /target` with body `host:port` repoints it, and `GET /target` reads it.
 * Test infrastructure only; it never ships in the product.
 */
import net from "node:net";
import http from "node:http";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function hostPort(s) {
  const m = /^([^:]+):(\d{1,5})$/.exec(String(s ?? ""));
  if (!m) throw new Error(`expected host:port, got ${JSON.stringify(s)}`);
  return { host: m[1], port: Number(m[2]) };
}

export function startWriterProxy({ listen, control, target }) {
  let current = target;
  const open = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(current.port, current.host);
    const pair = { client, upstream };
    open.add(pair);
    const close = () => {
      open.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
    client.pipe(upstream).pipe(client);
  });
  const ctl = http.createServer((req, res) => {
    if (req.url !== "/target") return res.writeHead(404).end();
    if (req.method === "GET") return res.end(`${current.host}:${current.port}`);
    if (req.method !== "PUT") return res.writeHead(405).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        current = hostPort(body.trim());
      } catch (e) {
        return res.writeHead(400).end(String(e));
      }
      // a failover ends every session on the old primary
      for (const p of open) {
        p.client.destroy();
        p.upstream.destroy();
      }
      open.clear();
      res.end(`${current.host}:${current.port}`);
    });
  });
  return Promise.all([
    new Promise((r) => server.listen(listen.port, listen.host, r)),
    new Promise((r) => ctl.listen(control.port, control.host, r)),
  ]).then(() => ({
    close: () => {
      for (const p of open) {
        p.client.destroy();
        p.upstream.destroy();
      }
      return Promise.all([new Promise((r) => server.close(r)), new Promise((r) => ctl.close(r))]);
    },
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const listen = hostPort(arg("listen", "0.0.0.0:5432"));
  const control = hostPort(arg("control", "0.0.0.0:5499"));
  const target = hostPort(arg("target"));
  await startWriterProxy({ listen, control, target });
  console.log(`[writer-proxy] ${listen.host}:${listen.port} -> ${target.host}:${target.port} (control ${control.host}:${control.port})`);
}
