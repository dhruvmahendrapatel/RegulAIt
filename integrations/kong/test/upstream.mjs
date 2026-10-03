/**
 * The counting upstream. This is the whole point of the harness.
 *
 * A proxy authorization test that only checks the STATUS CODE the client saw
 * can pass while the request was forwarded anyway — a 403 rendered after the
 * upstream already ran is indistinguishable, from the client's side, from a
 * refusal. The Envoy adapter that shipped failing open would have passed such a
 * test. So the assertion that matters is not "the client got 403", it is
 * "THE UPSTREAM WAS NEVER CALLED", and that requires something on the other
 * side keeping count.
 */
import { createServer } from "node:http";

let count = 0;
const port = Number(process.env.UPSTREAM_PORT ?? 8099);

createServer((req, res) => {
  if (req.url === "/__count") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ count }));
    return;
  }
  if (req.url === "/__reset") {
    count = 0;
    res.writeHead(200).end("{}");
    return;
  }
  // ---- STUB PDP ENDPOINTS (AER-034) -------------------------------------
  //
  // The plugin's two failure branches are `if not res` (unreachable) and
  // `res.status ~= 200` (an answer it will not act on). The unreachable branch
  // was asserted by killing the gateway; these two paths let the OTHER branch be
  // asserted, by pointing a second governed route's `pdp_url` at them.
  //
  // They must NOT increment the counter: they are the PDP standing in for a
  // broken one, not the upstream being reached. Counting them would make the
  // very assertion they exist for ("zero upstream calls") unfalsifiable.
  if (req.url?.startsWith("/__pdp500")) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "pdp_exploded" }));
    return;
  }
  if (req.url?.startsWith("/__pdpjunk")) {
    // 200 with a body `cjson.decode` cannot parse — the plugin must refuse
    // rather than treat an unreadable answer as an allow
    res.writeHead(200, { "content-type": "application/json" });
    res.end("this is not json {{{");
    return;
  }

  // Anything else is a real proxied request and is what we are counting.
  count += 1;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ reached: true, n: count }));
}).listen(port, () => console.log(`upstream counting on :${port}`));
