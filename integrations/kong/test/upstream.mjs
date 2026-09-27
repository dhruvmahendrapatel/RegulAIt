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
  // Anything else is a real proxied request and is what we are counting.
  count += 1;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ reached: true, n: count }));
}).listen(port, () => console.log(`upstream counting on :${port}`));
