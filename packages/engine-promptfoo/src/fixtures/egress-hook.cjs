// TEST FIXTURE (promptfoo-real.test.ts): a preload that records, and blocks, every outbound
// TCP connect or name lookup that is not loopback, so a real promptfoo run can be shown to make
// no call except to the (local, fake) gateway. A blocked connect fails like an internal network
// would (ENOTFOUND). The log path comes from EGRESS_LOG.
const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");
const OUT = process.env.EGRESS_LOG;
const note = (what) => fs.appendFileSync(OUT, `${process.pid} ${what}\n`);
const loop = (h) => !h || h === "127.0.0.1" || h === "localhost" || h === "::1";
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  if (o.path === undefined && !loop(o.host)) {
    note(`connect ${o.host}:${o.port}`);
    const e = Object.assign(new Error(`getaddrinfo ENOTFOUND ${o.host}`), { code: "ENOTFOUND" });
    process.nextTick(() => this.destroy(e));
    return this;
  }
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (!loop(host)) note(`lookup ${host}`);
  return origLookup.call(this, host, ...rest);
};
