/**
 * ADR-0194 — scripts/install.sh asks for the first admin and retires the
 * bootstrap token. No database and no Docker: the prompt loop
 * (scripts/lib/first-admin.sh) runs against a stub runner, and the whole
 * installer runs against a fake `docker` on PATH that plays the gateway
 * container's first-admin.js (its exit codes are the contract).
 *
 * Covered (the ADR's test list):
 *  - the mismatch re-prompt and the policy-refusal re-prompt;
 *  - the password never in output, .env, the override or any process argv —
 *    it reaches the runner on stdin only;
 *  - token retirement: gone from .env, pinned EMPTY in compose.install.yml
 *    (absent, docker-compose.yml would fall back to `dev-bootstrap`), the
 *    gateway restarted, and a re-run keeps it retired;
 *  - the skip on re-run: an existing admin means no prompt, no create call;
 *  - the password file must be 0600 or stricter.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chownSync, symlinkSync } from "node:fs";
import { describeFirstAdminError } from "./first-admin-lib.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL = path.join(root, "scripts/install.sh");
const LIB = path.join(root, "scripts/lib/first-admin.sh");
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const posix = process.platform !== "win32";

/** synthetic, minted per run — never a real password (gitleaks: CANARY) */
const strong = () => `CANARY-${randomBytes(9).toString("base64url")}-Aa1!`;

let sandbox: string;
beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "install-first-admin-"));
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function freshDir(name: string): string {
  const d = path.join(sandbox, `${name}-${randomBytes(4).toString("hex")}`);
  mkdirSync(d, { recursive: true });
  return d;
}

// ---------------------------------------------------------------------------
// 1. the prompt loop, against a stub runner
// ---------------------------------------------------------------------------

/** a stub first_admin_exec: records argv and stdin, applies a 12-char / 3-class policy, exit codes as first-admin.js */
const STUB = String.raw`
first_admin_exec() {
  local pw
  printf '%s\n' "$*" >> "$STUB_DIR/argv.log"
  pw="$(cat)"
  printf '%s\n' "$pw" >> "$STUB_DIR/stdin.log"
  if [ "$(printf %s "$pw" | wc -c)" -lt 12 ]; then echo "first admin refused: password must be at least 12 characters (org password policy). Nothing was changed."; return 4; fi
  case "$*" in *"--username taken "*) echo "first admin refused: username 'taken' already belongs to another account. Nothing was changed."; return 5 ;; esac
  echo "first admin created: (stub)"; return 0
}
`;

function runLoop(stdin: string): { status: number; out: string; argv: string; stdinLog: string[] } {
  const dir = freshDir("stub");
  const script = `set -euo pipefail\n. "${LIB}"\n${STUB}\nrc=0\nfirst_admin_interactive || rc=$?\necho "RC=$rc USER=$FA_USERNAME EMAIL=$FA_EMAIL"\n`;
  const r = spawnSync("bash", ["-c", script], { input: stdin, encoding: "utf8", env: { ...process.env, STUB_DIR: dir } });
  const read = (f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8") : "");
  return {
    status: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    argv: read("argv.log"),
    stdinLog: read("stdin.log").split("\n").filter(Boolean),
  };
}

describe("scripts/lib/first-admin.sh — the interactive prompt loop", () => {
  it.runIf(posix)("a mismatched repetition re-prompts, and only the confirmed password reaches the runner — on stdin", () => {
    const good = strong();
    const r = runLoop(["", "ops@acme.example", good, `${good}x`, good, good, ""].join("\n"));
    expect(r.out).toContain("RC=0 USER=admin EMAIL=ops@acme.example");
    expect(r.out).toContain("do not match");
    expect(r.stdinLog).toEqual([good]);
    expect(r.argv).toContain("--username admin --email ops@acme.example");
    expect(r.argv).not.toContain(good);
    expect(r.out).not.toContain(good);
  });

  it.runIf(posix)("a password the policy refuses re-prompts for the password (not the identity) until one passes", () => {
    const weak = "CANARYweak";
    const good = strong();
    const r = runLoop(["Ops.Lead", "ops@acme.example", weak, weak, good, good, ""].join("\n"));
    expect(r.out).toContain("org password policy");
    expect(r.out).toContain("choose another password");
    expect(r.out).toContain("RC=0 USER=ops.lead");
    expect(r.stdinLog).toEqual([weak, good]);
    expect(r.out).not.toContain(weak);
    expect(r.out).not.toContain(good);
  });

  it.runIf(posix)("an invalid username or email is asked again before any call; a taken username asks for the identity again", () => {
    const good = strong();
    const r = runLoop(["Bad User", "x@y", "taken", "not-an-email", "ops@acme.example", good, good, "admin2", "ops@acme.example", good, good, ""].join("\n"));
    expect(r.out).toContain("a username is 2-63 characters");
    expect(r.out).toContain("does not look like an email");
    expect(r.out).toContain("choose another username or email");
    expect(r.out).toContain("RC=0 USER=admin2");
    expect(r.argv.split("\n").filter(Boolean)).toEqual([
      "--username taken --email ops@acme.example",
      "--username admin2 --email ops@acme.example",
    ]);
  });

  it.runIf(posix)("end of input aborts without calling the runner", () => {
    const r = runLoop("admin\nops@acme.example\n");
    expect(r.out).toContain("RC=1");
    expect(r.argv).toBe("");
  });

  it.runIf(posix)("the password file must be a non-empty regular file, 0600 or stricter; the content is never printed", () => {
    const dir = freshDir("pwfile");
    const f = path.join(dir, "pw");
    const secret = strong();
    writeFileSync(f, `${secret}\n`, { mode: 0o644 });
    chmodSync(f, 0o644);
    const check = () =>
      execFileSync("bash", ["-c", `. "${LIB}"; fa_password_file_problem "$1"`, "x", f], { encoding: "utf8" }).trim();
    expect(check()).toContain("must be 0600 or stricter");
    chmodSync(f, 0o600);
    expect(check()).toBe("");
    chmodSync(f, 0o400);
    expect(check()).toBe("");
    expect(check()).not.toContain(secret);
    // owner-writable again first: a non-root runner cannot open a 0400 file for writing (root can, locally)
    chmodSync(f, 0o600);
    writeFileSync(f, "");
    expect(check()).toContain("is empty");
    expect(execFileSync("bash", ["-c", `. "${LIB}"; fa_password_file_problem "$1"`, "x", dir], { encoding: "utf8" })).toContain("not a regular file");
  });

  it.runIf(posix)("the password file: no symlink, one line (one trailing \\n or \\r\\n only), no byte-order mark, not just a newline", () => {
    const dir = freshDir("pwcontent");
    const f = path.join(dir, "pw");
    const problem = (p = f) =>
      execFileSync("bash", ["-c", `. "${LIB}"; fa_password_file_problem "$1"`, "x", p], { encoding: "utf8" }).trim();
    const put = (content: string | Buffer) => {
      rmSync(f, { force: true });
      writeFileSync(f, content, { mode: 0o600 });
      chmodSync(f, 0o600);
    };
    const pw = strong();
    put(pw);
    expect(problem()).toBe("");
    put(`${pw}\n`);
    expect(problem()).toBe("");
    put(`${pw}\r\n`);
    expect(problem()).toBe("");
    put(`${pw}\n\n`);
    expect(problem()).toContain("control characters");
    put(`${pw}\nsecond-line`);
    expect(problem()).toContain("control character");
    put(`CANARY\u0001${pw}`);
    expect(problem()).toContain("control character");
    put(`${pw}\r`);
    expect(problem()).toContain("control character");
    put(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(pw)]));
    expect(problem()).toContain("byte-order mark");
    put("\n");
    expect(problem()).toContain("is empty");
    put(pw);
    const link = path.join(dir, "link");
    symlinkSync(f, link);
    expect(problem(link)).toContain("symbolic link");
    for (const out of [problem(), problem(link)]) expect(out).not.toContain(pw);
  });

  it.runIf(posix)("the password file must be valid UTF-8", () => {
    const dir = freshDir("pwutf8");
    const f = path.join(dir, "pw");
    const problem = () =>
      execFileSync("bash", ["-c", `. "${LIB}"; fa_password_file_problem "$1"`, "x", f], { encoding: "utf8" }).trim();
    const put = (content: Buffer) => {
      rmSync(f, { force: true });
      writeFileSync(f, content, { mode: 0o600 });
      chmodSync(f, 0o600);
    };
    const pw = Buffer.from(strong());
    put(Buffer.concat([pw, Buffer.from("-pässwörd-\u{1F600}\n")]));
    expect(problem()).toBe("");
    for (const bad of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0x80]]) {
      put(Buffer.concat([pw, Buffer.from(bad)]));
      const out = problem();
      expect(out, bad.join(",")).toContain("not valid UTF-8");
      expect(out).not.toContain(pw.toString());
    }
  });

  it.runIf(posix && process.platform === "linux")("from a file: opened once, re-checked on that descriptor, and the runner reads that same descriptor", () => {
    const dir = freshDir("pwfd");
    const f = path.join(dir, "pw");
    const pw = strong();
    writeFileSync(f, `${pw}\n`, { mode: 0o600 });
    chmodSync(f, 0o600);
    // the descriptor's file is no longer the one at the path: refused, whatever the path now holds
    const swapped = path.join(dir, "swapped");
    writeFileSync(swapped, strong(), { mode: 0o600 });
    const swapCheck = execFileSync(
      "bash",
      ["-c", `. "${LIB}"; exec 9<"$1"; mv "$2" "$1"; fa_password_file_problem "$1" 9`, "x", f, swapped],
      { encoding: "utf8" },
    ).trim();
    expect(swapCheck).toContain("changed while it was being opened");
    expect(swapCheck).not.toContain(pw);
    // a good file: the stub runner receives exactly its content, on stdin, once
    writeFileSync(f, `${pw}\n`, { mode: 0o600 });
    chmodSync(f, 0o600);
    const stubDir = freshDir("pwfd-stub");
    const script = `set -euo pipefail\n. "${LIB}"\n${STUB}\nFA_USERNAME=admin; FA_EMAIL=ops@acme.example\nrc=0\nfirst_admin_from_file "$1" || rc=$?\necho "RC=$rc"\n`;
    const r = spawnSync("bash", ["-c", script, "x", f], { encoding: "utf8", env: { ...process.env, STUB_DIR: stubDir } });
    expect(r.stdout.trim(), r.stderr).toBe("RC=0");
    expect(readFileSync(path.join(stubDir, "stdin.log"), "utf8")).toBe(`${pw}\n`);
    expect(`${r.stdout}${r.stderr}`).not.toContain(pw);
  });

  // A swap BEFORE the open is not a race: descriptor 9 then opens the new file, which the path names and which is
  // checked in full. The window the descriptor closes is the one after the open, so the hook is the re-check on fd 9.
  it.runIf(posix && process.platform === "linux")("from a file: a swap after the open is refused, or never reaches the runner", () => {
    const run = (when: "before" | "after") => {
      const dir = freshDir(`pwrace-${when}`);
      const f = path.join(dir, "pw");
      const pw = strong();
      writeFileSync(f, `${pw}\n`, { mode: 0o600 });
      chmodSync(f, 0o600);
      const swapped = path.join(dir, "swapped");
      const other = strong();
      writeFileSync(swapped, `${other}\n`, { mode: 0o600 });
      chmodSync(swapped, 0o600);
      const stubDir = freshDir(`pwrace-${when}-stub`);
      // the file at the path is replaced just before, or just after, the re-check of the open descriptor
      const wrap = String.raw`
eval "fa_real_problem() $(declare -f fa_password_file_problem | tail -n +2)"
fa_password_file_problem() {
  if [ "$#" -eq 2 ] && [ "$SWAP_WHEN" = before ]; then mv "$SWAPPED" "$1"; fi
  fa_real_problem "$@"
  if [ "$#" -eq 2 ] && [ "$SWAP_WHEN" = after ]; then mv "$SWAPPED" "$1"; fi
}
`;
      const script = `set -euo pipefail\n. "${LIB}"\n${STUB}\n${wrap}\nFA_USERNAME=admin; FA_EMAIL=ops@acme.example\nrc=0\nfirst_admin_from_file "$1" || rc=$?\necho "RC=$rc OUT=$FA_OUTPUT"\n`;
      const r = spawnSync("bash", ["-c", script, "x", f], {
        encoding: "utf8",
        env: { ...process.env, STUB_DIR: stubDir, SWAPPED: swapped, SWAP_WHEN: when },
      });
      const log = path.join(stubDir, "stdin.log");
      return { r, pw, other, swapped, stdinLog: existsSync(log) ? readFileSync(log, "utf8") : null };
    };
    const before = run("before");
    expect(before.r.stdout, before.r.stderr).toContain("RC=2 ");
    expect(before.r.stdout).toContain("changed while it was being opened");
    expect(before.stdinLog).toBeNull();
    expect(existsSync(before.swapped)).toBe(false); // the swap really happened
    const after = run("after");
    expect(after.r.stdout.trim(), after.r.stderr).toBe("RC=0 OUT=first admin created: (stub)");
    expect(after.stdinLog).toBe(`${after.pw}\n`); // what was checked, not what the path now holds
    expect(existsSync(after.swapped)).toBe(false);
    for (const x of [before, after]) {
      expect(`${x.r.stdout}${x.r.stderr}`).not.toContain(x.pw);
      expect(`${x.r.stdout}${x.r.stderr}`).not.toContain(x.other);
    }
  });

  it.runIf(posix)("the password file's directory must not be writable by anyone but its owner", () => {
    const dir = freshDir("pwdir");
    const f = path.join(dir, "pw");
    writeFileSync(f, strong(), { mode: 0o600 });
    chmodSync(f, 0o600);
    const problem = () =>
      execFileSync("bash", ["-c", `. "${LIB}"; fa_password_file_problem "$1"`, "x", f], { encoding: "utf8" }).trim();
    chmodSync(dir, 0o700);
    expect(problem()).toBe("");
    for (const mode of [0o770, 0o707, 0o1777, 0o722]) {
      chmodSync(dir, mode);
      expect(problem(), mode.toString(8)).toContain("no one but its owner may write to it");
    }
    chmodSync(dir, 0o755);
    expect(problem()).toBe("");
  });

  it.runIf(posix && process.platform === "linux")("from a file: a bad file swapped in after the path check is refused by first_admin_from_file, nothing sent", () => {
    // review L1: the race itself, through first_admin_from_file. The path-only check passes on the good file; the file
    // is then swapped for one the checks refuse (group-readable, or a symlink to such a file) before it is opened.
    // Re-checking what was opened refuses it; the old check-then-redirect sent the swapped content to the runner.
    const race = [
      `eval "$(declare -f fa_password_file_problem | sed '1s/fa_password_file_problem/fa_real_problem/')"`,
      "fa_password_file_problem() {",
      '  fa_real_problem "$@"',
      '  if [ "$#" -lt 2 ]; then rm -f "$1"; if [ "$SWAP_KIND" = link ]; then ln -s "$SWAP_FROM" "$1"; else mv "$SWAP_FROM" "$1"; fi; fi',
      "}",
    ].join("\n");
    for (const kind of ["group-readable", "link"] as const) {
      const dir = freshDir(`pwrace-${kind}`);
      const f = path.join(dir, "pw");
      const swapped = path.join(dir, "swapped");
      const pw = strong();
      const intruder = `CANARY-intruder-${randomBytes(6).toString("hex")}`;
      writeFileSync(f, `${pw}\n`, { mode: 0o600 });
      chmodSync(f, 0o600);
      writeFileSync(swapped, `${intruder}\n`, { mode: 0o644 });
      chmodSync(swapped, 0o644);
      const stubDir = freshDir(`pwrace-${kind}-stub`);
      const script = `set -euo pipefail\n. "${LIB}"\n${STUB}\n${race}\nFA_USERNAME=admin; FA_EMAIL=ops@acme.example\nrc=0\nfirst_admin_from_file "$1" || rc=$?\necho "RC=$rc"\necho "OUT=$FA_OUTPUT"\n`;
      const r = spawnSync("bash", ["-c", script, "x", f], {
        encoding: "utf8",
        env: { ...process.env, STUB_DIR: stubDir, SWAP_FROM: swapped, SWAP_KIND: kind === "link" ? "link" : "file" },
      });
      expect(r.stdout, `${kind}: ${r.stderr}`).toContain("RC=2");
      expect(r.stdout, kind).toContain("OUT=password file refused:");
      expect(existsSync(path.join(stubDir, "stdin.log")), `${kind}: the runner was called`).toBe(false);
      expect(`${r.stdout}${r.stderr}`).not.toContain(intruder);
      expect(`${r.stdout}${r.stderr}`).not.toContain(pw);
    }
  });

  it.runIf(posix && process.getuid?.() === 0)("the password file's directory must be owned by the installing user or root", () => {
    // review R2: a directory another user owns can be re-moded by them, so the file in it could be swapped
    const dir = freshDir("pwdirowner");
    const f = path.join(dir, "pw");
    writeFileSync(f, strong(), { mode: 0o600 });
    chmodSync(f, 0o600);
    chmodSync(dir, 0o755);
    const problem = () =>
      execFileSync("bash", ["-c", `. "${LIB}"; fa_password_file_problem "$1"`, "x", f], { encoding: "utf8" }).trim();
    expect(problem()).toBe(""); // live control: root's own 0755 directory
    chownSync(dir, 12345, 12345);
    expect(problem()).toContain("is owned by uid 12345");
    chownSync(dir, 0, 0);
    expect(problem()).toBe("");
  });

  it.runIf(posix && process.platform === "linux")("from a file: refused outside Linux, before anything is opened or sent", () => {
    // review R3: a bash function shadows the uname binary inside $(...), so the gate sees another kernel
    const dir = freshDir("pwdarwin");
    const f = path.join(dir, "pw");
    const pw = strong();
    writeFileSync(f, `${pw}\n`, { mode: 0o600 });
    chmodSync(f, 0o600);
    const run = (kernel: string) => {
      const stubDir = freshDir(`pwdarwin-stub-${kernel}`);
      const shim = kernel === "Linux" ? "" : `uname() { echo ${kernel}; }`;
      const script = `set -euo pipefail\n. "${LIB}"\n${STUB}\n${shim}\nFA_USERNAME=admin; FA_EMAIL=ops@acme.example\nrc=0\nfirst_admin_from_file "$1" || rc=$?\necho "RC=$rc"\necho "OUT=$FA_OUTPUT"\n`;
      const r = spawnSync("bash", ["-c", script, "x", f], { encoding: "utf8", env: { ...process.env, STUB_DIR: stubDir } });
      return { out: `${r.stdout}${r.stderr}`, sent: existsSync(path.join(stubDir, "stdin.log")) };
    };
    const darwin = run("Darwin");
    expect(darwin.out).toContain("RC=2");
    expect(darwin.out).toContain("supported on Linux only");
    expect(darwin.sent, "the runner was called").toBe(false);
    expect(darwin.out).not.toContain(pw);
    // live control: on Linux the same file reaches the runner
    const linux = run("Linux");
    expect(linux.out).not.toContain("supported on Linux only");
    expect(linux.sent).toBe(true);
  });

  it.runIf(posix && process.getuid?.() === 0)("the password file must be owned by the installing user or root", () => {
    const f = path.join(freshDir("pwowner"), "pw");
    writeFileSync(f, strong(), { mode: 0o600 });
    chownSync(f, 65534, 65534);
    const out = execFileSync("bash", ["-c", `. "${LIB}"; fa_password_file_problem "$1"`, "x", f], { encoding: "utf8" });
    expect(out).toContain("owned by uid 65534");
  });
});

// ---------------------------------------------------------------------------
// 2. the whole installer, against a fake docker
// ---------------------------------------------------------------------------

const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
# fake docker for install-first-admin.test.ts — records argv, plays the gateway's first-admin.js
printf '%s\n' "$*" >> "$FAKE_DOCKER_DIR/argv.log"
case "$*" in
  --version) echo "Docker version 99.0.0-fake"; exit 0 ;;
  info*) exit 0 ;;
  ps*) echo "fakecontainer"; exit 0 ;;
  "volume inspect"*) exit 1 ;;
  "image inspect"*) exit 0 ;;
  "compose version --short") echo "2.99.0"; exit 0 ;;
  "compose version") echo "Docker Compose version v2.99.0"; exit 0 ;;
esac
case "$*" in
  *receipt-key-init.js*) echo "receipt signing key: install-generated install-ed25519-fake"; exit 0 ;;
  *first-admin.js*--status*)
    if [ -f "$FAKE_DOCKER_DIR/admin-exists" ]; then
      if [ "$(cat "$FAKE_DOCKER_DIR/admin-exists")" = "demo" ]; then echo "first admin: only the demo seed's personas are admins — nothing to do"; exit 3; fi
      echo "first admin: an active admin already exists — nothing to do"; exit 3
    fi
    echo "first admin: none yet"; exit 0 ;;
  *first-admin.js*)
    pw="$(cat)"
    printf '%s\n' "$pw" >> "$FAKE_DOCKER_DIR/stdin.log"
    if [ "$(printf %s "$pw" | wc -c)" -lt 12 ]; then echo "first admin refused: password must be at least 12 characters (org password policy). Nothing was changed." >&2; exit 4; fi
    touch "$FAKE_DOCKER_DIR/admin-exists"
    echo "first admin created: (fake)"; exit 0 ;;
  *" config"*) exit 0 ;;
  *" up -d --no-build"*) if [ -n "$FAKE_RETIRE_UP_FAIL" ]; then echo "fake: up failed" >&2; exit 1; fi; exit 0 ;;
  *" up "*|*" up") exit 0 ;;
esac
exit 0
`;

describe("scripts/install.sh — the first-admin step and token retirement (fake docker)", () => {
  function setupFakes(): { bin: string; state: string } {
    const base = freshDir("fake");
    const bin = path.join(base, "bin");
    const state = path.join(base, "state");
    mkdirSync(bin);
    mkdirSync(state);
    writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
    // the readiness probe answers at once
    writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return { bin, state };
  }

  function install(dir: string, fakes: { bin: string; state: string }, extraEnv: Record<string, string>, args: string[] = []) {
    const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
    env.PATH = `${fakes.bin}:${process.env.PATH}`;
    env.FAKE_DOCKER_DIR = fakes.state;
    for (const k of ["REGULAIT_DEMO_LICENSE", "REGULAIT_BOOTSTRAP_TOKEN", "REGULAIT_DATA_KEY", "REGULAIT_RECEIPT_KEY_HOST_FILE", "REGULAIT_RECEIPT_KEY_HOST_ID"]) {
      if (!(k in extraEnv)) delete env[k];
    }
    for (const k of ["REGULAIT_FIRST_ADMIN_PASSWORD_FILE", "REGULAIT_FIRST_ADMIN_EMAIL", "REGULAIT_FIRST_ADMIN_USERNAME"]) {
      if (!(k in extraEnv)) delete env[k];
    }
    const dataKey = execFileSync("openssl", ["rand", "-hex", "32"], { encoding: "utf8" }).trim();
    const r = spawnSync(
      "bash",
      [INSTALL, "--yes", "--mode", "byoc", "--domain", "fa.example", "--tls", "internal", "--dir", dir, "--data-key", dataKey, "--min-disk-gb", "0", ...args],
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
    const read = (f: string) => (existsSync(path.join(fakes.state, f)) ? readFileSync(path.join(fakes.state, f), "utf8") : "");
    return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, argv: read("argv.log"), stdinLog: read("stdin.log") };
  }

  const envOf = (dir: string) => readFileSync(path.join(dir, ".env"), "utf8");
  const overrideOf = (dir: string) => readFileSync(path.join(dir, "compose.install.yml"), "utf8");

  it.runIf(hasOpenssl && posix)("from a 0600 password file: created through the runner's stdin, never printed or written, then the token is retired", () => {
    const dir = freshDir("install");
    const fakes = setupFakes();
    const pwFile = path.join(freshDir("secret"), "first-admin-password");
    const password = strong();
    writeFileSync(pwFile, `${password}\n`, { mode: 0o600 });

    const r = install(dir, fakes, {
      REGULAIT_FIRST_ADMIN_PASSWORD_FILE: pwFile,
      REGULAIT_FIRST_ADMIN_EMAIL: "ops@acme.example",
      REGULAIT_FIRST_ADMIN_USERNAME: "Admin",
    });
    expect(r.status, r.out.slice(-3000)).toBe(0);
    expect(r.out).toContain("first admin created");
    expect(r.out).toContain("bootstrap token retired");
    expect(r.out).toContain("Created: 'admin'");

    // delivered on stdin, exactly once, and nowhere else
    expect(r.stdinLog).toBe(`${password}\n`);
    expect(r.argv).toContain("first-admin.js --username admin --email ops@acme.example");
    expect(r.argv).not.toContain(password);
    expect(r.out).not.toContain(password);
    expect(envOf(dir)).not.toContain(password);
    expect(overrideOf(dir)).not.toContain(password);

    // retired: no token line in .env, the marker instead, pinned empty in the override, gateway restarted
    expect(envOf(dir)).not.toMatch(/^REGULAIT_BOOTSTRAP_TOKEN=/m);
    expect(envOf(dir)).toMatch(/^REGULAIT_BOOTSTRAP_RETIRED=1$/m);
    expect(overrideOf(dir)).toContain('      REGULAIT_BOOTSTRAP_TOKEN: ""\n');
    const ups = r.argv.split("\n").filter((l) => /^compose .* up -d/.test(l));
    expect(ups).toHaveLength(2);
    expect(ups[1]).toContain("up -d --no-build");
    expect(r.out).not.toContain("REGULAIT_BOOTSTRAP_TOKEN — until");

    // RE-RUN: the admin exists — no create call, no password needed, the token stays retired
    const again = install(dir, fakes, {});
    expect(again.status, again.out.slice(-3000)).toBe(0);
    expect(again.out).toContain("an active admin already exists — skipped");
    expect(again.out).toContain("bootstrap token: retired");
    expect(again.out).toContain("An admin already exists");
    expect(again.argv.split("\n").filter((l) => l.includes("first-admin.js --username"))).toHaveLength(1); // the first run's only
    expect(envOf(dir)).not.toMatch(/^REGULAIT_BOOTSTRAP_TOKEN=/m);
    expect(overrideOf(dir)).toContain('REGULAIT_BOOTSTRAP_TOKEN: ""');
  });

  it.runIf(hasOpenssl && posix)("a policy refusal from the file stops the install with nothing created and the token still in .env", () => {
    const dir = freshDir("install-weak");
    const fakes = setupFakes();
    const pwFile = path.join(freshDir("secret"), "pw");
    writeFileSync(pwFile, "CANARYweak\n", { mode: 0o600 });
    const r = install(dir, fakes, { REGULAIT_FIRST_ADMIN_PASSWORD_FILE: pwFile, REGULAIT_FIRST_ADMIN_EMAIL: "ops@acme.example" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("the first admin was NOT created (exit 4)");
    expect(r.out).toContain("org password policy");
    expect(r.out).not.toContain("CANARYweak");
    expect(envOf(dir)).toMatch(/^REGULAIT_BOOTSTRAP_TOKEN=[0-9a-f]{48}$/m);
    expect(overrideOf(dir)).not.toContain("REGULAIT_BOOTSTRAP_TOKEN");
  });

  it.runIf(hasOpenssl && posix)("non-interactive with no password file: the step is skipped, the token stays, the summary gives the manual path", () => {
    const dir = freshDir("install-skip");
    const fakes = setupFakes();
    const r = install(dir, fakes, {});
    expect(r.status, r.out.slice(-3000)).toBe(0);
    expect(r.out).toContain("not created by this run");
    expect(r.out).toContain("RE-RUN THIS INSTALLER");
    expect(r.argv).not.toContain("first-admin.js --username");
    expect(envOf(dir)).toMatch(/^REGULAIT_BOOTSTRAP_TOKEN=[0-9a-f]{48}$/m);
    // an admin made by hand (the manual path), then a re-run: the installer retires the token
    writeFileSync(path.join(fakes.state, "admin-exists"), "");
    const again = install(dir, fakes, {});
    expect(again.status, again.out.slice(-3000)).toBe(0);
    expect(again.out).toContain("bootstrap token retired");
    expect(envOf(dir)).not.toMatch(/^REGULAIT_BOOTSTRAP_TOKEN=/m);
  });

  it.runIf(hasOpenssl && posix)("--check refuses a group-readable password file and a file without an email, before rendering", () => {
    const fakes = setupFakes();
    const pwFile = path.join(freshDir("secret"), "pw");
    writeFileSync(pwFile, `${strong()}\n`, { mode: 0o644 });
    chmodSync(pwFile, 0o644);
    const dir = freshDir("check-mode");
    const r = install(dir, fakes, { REGULAIT_FIRST_ADMIN_PASSWORD_FILE: pwFile, REGULAIT_FIRST_ADMIN_EMAIL: "ops@acme.example" }, ["--check"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("must be 0600 or stricter");
    expect(existsSync(path.join(dir, ".env"))).toBe(false);
    chmodSync(pwFile, 0o600);
    const noEmail = install(dir, fakes, { REGULAIT_FIRST_ADMIN_PASSWORD_FILE: pwFile }, ["--check"]);
    expect(noEmail.status).not.toBe(0);
    expect(noEmail.out).toContain("REGULAIT_FIRST_ADMIN_EMAIL is not");
  });

  it.runIf(hasOpenssl && posix)("--check refuses a password file outside Linux, before rendering", () => {
    // review R3: a fake uname on PATH reports another kernel for -s
    const fakes = setupFakes();
    writeFileSync(path.join(fakes.bin, "uname"), '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; exit 0; fi\nexec /usr/bin/env PATH=/usr/bin:/bin uname "$@"\n', { mode: 0o755 });
    const pwFile = path.join(freshDir("secret"), "pw");
    writeFileSync(pwFile, `${strong()}\n`, { mode: 0o600 });
    chmodSync(pwFile, 0o600);
    const dir = freshDir("check-darwin");
    const env = { REGULAIT_FIRST_ADMIN_PASSWORD_FILE: pwFile, REGULAIT_FIRST_ADMIN_EMAIL: "ops@acme.example" };
    const r = install(dir, fakes, env, ["--check"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("supported on Linux only");
    expect(existsSync(path.join(dir, ".env"))).toBe(false);
    // live control: without the fake, the same file passes the gate
    rmSync(path.join(fakes.bin, "uname"));
    expect(install(freshDir("check-linux"), fakes, env, ["--check"]).out).not.toContain("supported on Linux only");
  });

  it.runIf(hasOpenssl && posix)("a retired token stays retired on re-render; an exported token is ignored; only --admin-token re-opens it", () => {
    const fakes = setupFakes();
    const dir = freshDir("retired");
    writeFileSync(path.join(fakes.state, "admin-exists"), "");
    expect(install(dir, fakes, {}).status).toBe(0); // admin exists -> retired on the first run
    expect(envOf(dir)).toMatch(/^REGULAIT_BOOTSTRAP_RETIRED=1$/m);

    const exported = install(dir, fakes, { REGULAIT_BOOTSTRAP_TOKEN: "a-stray-exported-CANARY-token" }, ["--check"]);
    expect(exported.status).toBe(0);
    expect(exported.out).toContain("it is ignored");
    expect(envOf(dir)).not.toContain("a-stray-exported-CANARY-token");
    expect(overrideOf(dir)).toContain('REGULAIT_BOOTSTRAP_TOKEN: ""');

    const reopened = install(dir, fakes, {}, ["--admin-token", "reopened-CANARY-break-glass-token"]);
    expect(reopened.status, reopened.out.slice(-3000)).toBe(0);
    expect(reopened.out).toContain("re-opens the retired bootstrap token");
    expect(reopened.out).toContain("The bootstrap token is OPEN");
    expect(envOf(dir)).toContain("REGULAIT_BOOTSTRAP_TOKEN=reopened-CANARY-break-glass-token\n");
    expect(overrideOf(dir)).not.toContain("REGULAIT_BOOTSTRAP_TOKEN");
    // and a plain re-run retires it again
    const plain = install(dir, fakes, {});
    expect(plain.status).toBe(0);
    expect(envOf(dir)).not.toMatch(/^REGULAIT_BOOTSTRAP_TOKEN=/m);
  });
  it.runIf(hasOpenssl && posix)("--admin-token on a FIRST install only picks the value: the token is still retired once the admin exists", () => {
    const dir = freshDir("first-flag");
    const fakes = setupFakes();
    const pwFile = path.join(freshDir("secret"), "pw");
    writeFileSync(pwFile, strong(), { mode: 0o600 });
    const r = install(dir, fakes, { REGULAIT_FIRST_ADMIN_PASSWORD_FILE: pwFile, REGULAIT_FIRST_ADMIN_EMAIL: "ops@acme.example" }, [
      "--admin-token",
      "first-install-CANARY-token-value",
    ]);
    expect(r.status, r.out.slice(-3000)).toBe(0);
    expect(r.out).not.toContain("re-opens the retired bootstrap token");
    expect(r.out).toContain("bootstrap token retired");
    expect(envOf(dir)).not.toContain("first-install-CANARY-token-value");
    expect(overrideOf(dir)).toContain('REGULAIT_BOOTSTRAP_TOKEN: ""');
  });

  it.runIf(hasOpenssl && posix)("a failed restart while retiring stops the install and says the running gateway still holds the old token", () => {
    const dir = freshDir("retire-fail");
    const fakes = setupFakes();
    writeFileSync(path.join(fakes.state, "admin-exists"), "");
    const r = install(dir, fakes, { FAKE_RETIRE_UP_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("the RUNNING");
    expect(r.out).toContain("still accepts the old token");
    expect(r.out).toContain("re-run this installer");
  });

  it.runIf(hasOpenssl && posix)("retired with no active admin: the summary prints no empty Bearer curl, it says how to proceed", () => {
    const dir = freshDir("retired-noadmin");
    const fakes = setupFakes();
    writeFileSync(path.join(fakes.state, "admin-exists"), "");
    expect(install(dir, fakes, {}).status).toBe(0);
    rmSync(path.join(fakes.state, "admin-exists"));
    const r = install(dir, fakes, {});
    expect(r.status, r.out.slice(-3000)).toBe(0);
    expect(r.out).toContain("none active, and the bootstrap token is retired");
    expect(r.out).toContain("--admin-token");
    expect(r.out).not.toMatch(/Bearer \s*"/);
    expect(r.out).not.toContain("/v1/users \\");
  });

  it.runIf(hasOpenssl && posix)("--seed-demo: the summary says the demo personas are the admins and how to replace them", () => {
    const dir = freshDir("seed-demo");
    const fakes = setupFakes();
    writeFileSync(path.join(fakes.state, "admin-exists"), "demo");
    const r = install(dir, fakes, {}, ["--seed-demo"]);
    expect(r.status, r.out.slice(-3000)).toBe(0);
    expect(r.out).toContain("its personas are the admins");
    expect(r.out).toContain("admin@regulait.local");
    expect(r.out).toContain("create your admin under Admin -> Users");
    expect(r.out).toContain("The bootstrap token is retired: removed from");
  });

  it.runIf(hasOpenssl && posix)("--seed-demo with a real admin already there: the summary says the seed loaded nothing, not that the demo admin is the admin", () => {
    const dir = freshDir("seed-demo-real");
    const fakes = setupFakes();
    writeFileSync(path.join(fakes.state, "admin-exists"), "");
    const r = install(dir, fakes, {}, ["--seed-demo"]);
    expect(r.status, r.out.slice(-3000)).toBe(0);
    expect(r.out).toContain("An admin of your own already exists, so --seed-demo loaded nothing");
    expect(r.out).not.toContain("its personas are the admins");
    expect(r.out).not.toContain("admin@regulait.local");
    expect(r.out).not.toContain("still live");
  });
});

// ---------------------------------------------------------------------------
// 3. the CLI's error line never carries a query's params
// ---------------------------------------------------------------------------

describe("describeFirstAdminError (first-admin.js's catch)", () => {
  // the shape drizzle throws: the message repeats the statement and its params
  const hash = "scrypt$16384$8$1$c2FsdA$CANARYhashCANARYhash";
  const email = "canary-leak@acme.example";
  const queryError = (code: string) =>
    Object.assign(new Error(`Failed query: insert into "users" ... \nparams: ${email},admin,${hash}`), {
      name: "DrizzleQueryError",
      cause: Object.assign(new Error(`duplicate key value violates unique constraint "users_email_unique" Key (email)=(${email})`), { code }),
    });

  it("a unique violation is the identity refusal (exit 5), naming neither the email nor the hash", () => {
    const d = describeFirstAdminError(queryError("23505"));
    expect(d.exitCode).toBe(5);
    expect(d.line).not.toContain(email);
    expect(d.line).not.toContain(hash);
    expect(d.line).not.toContain("CANARY");
  });

  it("any other failure prints the class and SQLSTATE only (exit 2)", () => {
    const d = describeFirstAdminError(queryError("53300"));
    expect(d).toEqual({ exitCode: 2, line: expect.stringContaining("DrizzleQueryError (database error 53300)") });
    expect(d.line).not.toContain(email);
    expect(d.line).not.toContain("CANARY");
    const plain = describeFirstAdminError(new Error(`connect failed for ${email}`));
    expect(plain.exitCode).toBe(2);
    expect(plain.line).not.toContain(email);
    expect(describeFirstAdminError("weird").line).toContain("first-admin failed: Error");
  });
});
