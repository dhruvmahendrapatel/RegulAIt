/**
 * The short system-prompt hash an eval or red-team run records (`eval_runs.system_prompt_hash`, copied onto
 * `redteam_runs`). A leaf module (no gateway imports), so a reader such as the copilot red-team gate can compare an
 * agent's prompt with a run's without importing the eval runner.
 */
import crypto from "node:crypto";

export function hashPrompt(prompt: string | null): string | null {
  if (!prompt) return null;
  return crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}
