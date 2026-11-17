/**
 * ADR-0343 slice 3: the NATIVE backend of the failover suite. It runs Postgres binaries and gateway processes on
 * this machine, with no Docker. It is what CI and a laptop without Docker run, and what the suite was proven on.
 *
 * Postgres: a primary and one SYNCHRONOUS standby (`synchronous_standby_names = 'FIRST 1 (standby1)'`,
 * `synchronous_commit = on`), streaming over loopback. "Kill the primary" is `pg_ctl stop -m immediate` (no
 * checkpoint, no shutdown record, the same as a crash), and "promote" is `pg_ctl promote`.
 * Gateways are `node apps/gateway/dist/main.js` processes, killed with SIGKILL.
 *
 * Auth is `trust` on 127.0.0.1 only: the clusters are disposable, bound to loopback, and deleted at the end.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, appendFileSync, rmSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function pgBinDir() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  try {
    return execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
  } catch {
    return "/usr/lib/postgresql/16/bin";
  }
}

export function nativeBackend({ repoRoot, primaryPort = 25432, standbyPort = 25433, asyncReplication = false, log }) {
  const bin = pgBinDir();
  const root = mkdtempSync(path.join(tmpdir(), "regulait-ha-"));
  // initdb refuses to run as root: under root, the clusters belong to the `postgres` user
  const asRoot = process.getuid?.() === 0;
  const pgUser = asRoot ? "postgres" : null;
  const run = (cmd, args) => {
    const full = pgUser ? ["runuser", ["-u", pgUser, "--", path.join(bin, cmd), ...args]] : [path.join(bin, cmd), args];
    return execFileSync(full[0], full[1], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  };
  const primary = path.join(root, "primary");
  const standby = path.join(root, "standby");
  const sock = path.join(root, "sock");
  const gateways = new Map();

  const conf = (dir, lines) => appendFileSync(path.join(dir, "postgresql.conf"), `\n# ADR-0343 failover suite\n${lines.join("\n")}\n`);

  return {
    name: "native",
    root,
    primary: { host: "127.0.0.1", port: primaryPort },
    standby: { host: "127.0.0.1", port: standbyPort },

    async up() {
      mkdirSync(sock);
      if (pgUser) execFileSync("chown", ["-R", `${pgUser}:${pgUser}`, root]);
      run("initdb", ["-D", primary, "-U", "regulait", "--auth=trust", "-E", "UTF8", "--no-instructions"]);
      conf(primary, [
        `port = ${primaryPort}`,
        "listen_addresses = '127.0.0.1'",
        `unix_socket_directories = '${sock}'`,
        "wal_level = replica",
        "max_wal_senders = 5",
        "hot_standby = on",
        // synchronous_standby_names is set once the standby is attached (below): set now, createdb would wait forever
        "synchronous_commit = on",
        "max_connections = 200",
      ]);
      appendFileSync(path.join(primary, "pg_hba.conf"), "\nhost replication regulait 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 trust\n");
      run("pg_ctl", ["-D", primary, "-l", path.join(root, "primary.log"), "-w", "start"]);
      run("createdb", ["-h", "127.0.0.1", "-p", String(primaryPort), "-U", "regulait", "regulait"]);
      // the standby: a base backup that streams, names itself standby1 (so the primary counts it as synchronous)
      run("pg_basebackup", [
        "-d", `host=127.0.0.1 port=${primaryPort} user=regulait application_name=standby1`,
        "-D", standby, "-R", "-X", "stream", "-c", "fast",
      ]);
      conf(standby, [
        `port = ${standbyPort}`,
        // once promoted it has no standby of its own; it must not wait for one
        "synchronous_standby_names = ''",
      ]);
      run("pg_ctl", ["-D", standby, "-l", path.join(root, "standby.log"), "-w", "start"]);
      // RPO 0: from here a commit returns only once standby1 has flushed its WAL. `--async` (the negative control
      // only) leaves replication asynchronous, which is what the suite must catch.
      const psqlPrimary = (q) => run("psql", ["-h", "127.0.0.1", "-p", String(primaryPort), "-U", "regulait", "-d", "postgres", "-Atc", q]);
      if (!asyncReplication) {
        psqlPrimary("alter system set synchronous_standby_names = 'FIRST 1 (standby1)'");
        psqlPrimary("select pg_reload_conf()");
      }
      const want = asyncReplication ? "async" : "sync";
      // wait until the primary reports the standby as synchronous
      for (let i = 0; i < 100; i++) {
        const s = psqlPrimary("select sync_state from pg_stat_replication where application_name = 'standby1'").trim();
        if (s === want) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`the standby never reached sync_state ${want}`);
    },

    /**
     * Take the standby down (fast shutdown) so it falls behind; the returned function starts it again. Freezing only
     * the WAL receiver is not enough: WAL already in its socket buffer is still applied after it resumes.
     */
    async pauseStandby() {
      run("pg_ctl", ["-D", standby, "-m", "fast", "-w", "stop"]);
      return async () => {
        run("pg_ctl", ["-D", standby, "-l", path.join(root, "standby.log"), "-w", "start"]);
      };
    },

    async killPrimary() {
      run("pg_ctl", ["-D", primary, "-m", "immediate", "stop"]);
    },

    async promoteStandby() {
      run("pg_ctl", ["-D", standby, "-w", "promote"]);
    },

    async startGateway(name, { port, env }) {
      const out = openSync(path.join(root, `${name}.log`), "a");
      const child = spawn(process.execPath, [path.join(repoRoot, "apps/gateway/dist/main.js")], {
        env: { ...env, PORT: String(port), HOST: "127.0.0.1" },
        stdio: ["ignore", out, out],
      });
      gateways.set(name, child);
      return { url: `http://127.0.0.1:${port}`, logFile: path.join(root, `${name}.log`) };
    },

    async killGateway(name) {
      const child = gateways.get(name);
      if (!child || child.exitCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGKILL");
      await exited;
      gateways.delete(name);
    },

    async down({ keep = false } = {}) {
      for (const name of [...gateways.keys()]) await this.killGateway(name);
      for (const dir of [primary, standby]) {
        try {
          run("pg_ctl", ["-D", dir, "-m", "immediate", "stop"]);
        } catch {
          /* already stopped */
        }
      }
      if (!keep) rmSync(root, { recursive: true, force: true });
    },
  };
}

