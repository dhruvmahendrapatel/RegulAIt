/**
 * ADR-0030 — the username, the second login identifier. One validator and one
 * refusal reader for both writers: the admin route (`PUT /v1/users/:id/username`)
 * and the self-service route (`POST /auth/username`). The gateway is the
 * authority; this mirrors `usernameSchema` (packages/shared) so a person sees
 * the rule before submitting, and `username.test.ts` pins it.
 */
import { ApiError } from "../../api/client";

/** `USERNAME_PATTERN` (packages/shared/src/index.ts), mirrored */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export const USERNAME_RULE =
  "2 to 63 characters: letters, digits, '.', '_' and '-', starting with a letter or digit. No '@' and no spaces. Stored in lower case.";

/** the value the gateway would store (trimmed, lower-cased), or null with the reason it would refuse it */
export function normaliseUsername(input: string): { ok: true; value: string } | { ok: false; problem: string } {
  const value = input.trim().toLowerCase();
  if (value.length === 0) return { ok: false, problem: "Enter a username, or clear it." };
  if (value.length > 64 || !USERNAME_PATTERN.test(value)) return { ok: false, problem: USERNAME_RULE };
  return { ok: true, value };
}

/** a username refusal in words (the gateway's own detail when it sent one) */
export function usernameRefusal(err: unknown): string {
  if (err instanceof ApiError) {
    const code = err.payload.error;
    if (code === "username_taken") return err.payload.detail ?? "That username is already taken.";
    if (code === "username_self_service_disabled") {
      return "Usernames are managed by an administrator in this organization, so you can't change yours here.";
    }
    if (code === "unknown_user") return "This account no longer exists.";
    if (code === "no_user_identity") return "Only a signed-in person can set a username; the bootstrap operator has none.";
  }
  return err instanceof Error ? err.message : String(err);
}
