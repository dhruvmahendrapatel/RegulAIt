import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(here, ".e2e-state.json");

export default async function globalTeardown() {
  if (!existsSync(STATE_FILE)) return;
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { pid?: number };
    if (state.pid) process.kill(state.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  rmSync(STATE_FILE, { force: true });
}
