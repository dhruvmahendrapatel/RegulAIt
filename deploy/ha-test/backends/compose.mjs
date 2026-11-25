/**
 * ADR-0343 slice 3: the DOCKER COMPOSE backend of the failover suite (deploy/ha-test/compose.yml).
 *
 * The same five steps as the native backend, as Docker does them: "kill" is `docker compose kill -s SIGKILL` (a crash
 * for the gateway and for Postgres alike), and "promote" is `pg_ctl promote` inside the standby. The writer endpoint
 * is the `writer` service. The suite repoints it through its control port, which is published on 127.0.0.1.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

export function composeBackend({ here, asyncReplication = false, log }) {
  if (asyncReplication) throw new Error("--async (the negative control) runs on the native backend only");
  const file = path.join(here, "compose.yml");
  const password = randomBytes(18).toString("base64url");
  const env = {
    ...process.env,
    REGULAIT_HA_DB_PASSWORD: password,
    REGULAIT_HA_DATA_KEY: randomBytes(32).toString("hex"),
    REGULAIT_HA_BOOTSTRAP_TOKEN: process.env.REGULAIT_HA_BOOTSTRAP_TOKEN ?? `ha-suite-${randomBytes(12).toString("hex")}`,
  };
  const dc = (...args) =>
    execFileSync("docker", ["compose", "-f", file, "-p", "regulait-ha", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ports = { "gw-a": 13101, "gw-b": 13102 };

  /** what the primary and the standby say, for an error message: replication state and their recent logs */
  const diagnostics = () => {
    const safe = (f) => {
      try {
        return f();
      } catch (e) {
        return `(unavailable: ${e.message.split("\n")[0]})`;
      }
    };
    return [
      "pg_stat_replication:",
      safe(() => dc("exec", "-T", "-u", "postgres", "pg-primary", "psql", "-U", "regulait", "-d", "postgres", "-Atc",
        "select application_name, state, sync_state from pg_stat_replication")),
      "pg-primary / pg-standby logs (last 40 lines each):",
      safe(() => dc("logs", "--no-color", "--tail", "40", "pg-primary", "pg-standby")),
    ].join("\n");
  };

  return {
    name: "compose",
    root: null,
    primary: { host: "pg-primary", port: 5432 },
    standby: { host: "pg-standby", port: 5432 },
    writerUrl: `postgres://regulait:${password}@127.0.0.1:15432/regulait`,
    bootstrapToken: env.REGULAIT_HA_BOOTSTRAP_TOKEN,
    // the gateways' own settings live in compose.yml; the suite only reads them back
    gatewayManagesOwnEnv: true,

    async up() {
      log("building the gateway image (docker compose build)");
      dc("build", "gw-a");
      dc("up", "-d", "--wait", "pg-primary");
      dc("up", "-d", "pg-standby", "writer");
      const psqlPrimary = (q) =>
        dc("exec", "-T", "-u", "postgres", "pg-primary", "psql", "-U", "regulait", "-d", "postgres", "-Atc", q).trim();
      // the standby server itself (not pg_basebackup's own WAL stream, which also says standby1) accepts connections
      const standbyUp = () => {
        try {
          dc("exec", "-T", "-u", "postgres", "pg-standby", "pg_isready", "-U", "regulait");
          return "up";
        } catch {
          return ""; // not yet
        }
      };
      const syncState = () => {
        try {
          return psqlPrimary(
            "select sync_state from pg_stat_replication where application_name = 'standby1' and state = 'streaming'");
        } catch {
          return ""; // not yet
        }
      };
      const waitFor = async (probe, ok, tries) => {
        let s = "";
        for (let i = 0; i < tries; i++) {
          s = probe();
          if (ok(s)) return s;
          await new Promise((r) => setTimeout(r, 500));
        }
        return s;
      };
      // first standby1 must be up and streaming; only then may commits wait for it (compose.yml says why)
      if ((await waitFor(standbyUp, (s) => s === "up", 300)) !== "up") {
        throw new Error(`the standby never started\n${diagnostics()}`);
      }
      const attached = await waitFor(syncState, (s) => s !== "", 120);
      if (attached === "") throw new Error(`the standby never attached to the primary\n${diagnostics()}`);
      psqlPrimary("alter system set synchronous_standby_names = 'FIRST 1 (standby1)'");
      psqlPrimary("select pg_reload_conf()");
      const last = await waitFor(syncState, (s) => s === "sync", 120);
      if (last !== "sync") {
        throw new Error(`the standby never became synchronous (last sync_state: ${last || "none"})\n${diagnostics()}`);
      }
    },


    /** stop the standby so it falls behind; the returned function starts it again */
    async pauseStandby() {
      dc("stop", "pg-standby");
      return async () => {
        dc("start", "pg-standby");
        for (let i = 0; i < 120; i++) {
          try {
            dc("exec", "-T", "-u", "postgres", "pg-standby", "pg_isready", "-U", "regulait");
            return;
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        throw new Error("the standby did not come back");
      };
    },

    async killPrimary() {
      dc("kill", "-s", "SIGKILL", "pg-primary");
    },

    async promoteStandby() {
      dc("exec", "-T", "-u", "postgres", "pg-standby", "pg_ctl", "promote", "-w", "-D", "/var/lib/postgresql/data");
    },

    async repointWriter(target) {
      const r = await fetch("http://127.0.0.1:15499/target", { method: "PUT", body: `${target.host}:${target.port}` });
      if (!r.ok) throw new Error(`repoint failed: ${r.status}`);
    },

    async startGateway(name) {
      dc("up", "-d", "--no-deps", name);
      return { url: `http://127.0.0.1:${ports[name]}` };
    },

    async killGateway(name) {
      dc("kill", "-s", "SIGKILL", name);
    },

    async down() {
      try {
        dc("down", "-v", "--remove-orphans");
      } catch (e) {
        log(`compose down: ${e.message}`);
      }
    },
  };
}
