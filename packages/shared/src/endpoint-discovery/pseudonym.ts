/**
 * ADR-0195 decision 20 — people on endpoints are pseudonymous by default.
 *
 * The importers never keep a username, a Windows SID or a device name in
 * clear. They call a `EndpointPseudonymHook` that SD0 provides (a keyed hash,
 * HMAC key per tenant, as in ADR-0193; SD0 stores the display name encrypted in
 * its own table). There is no default hook: an importer called without one
 * refuses, so a missing wiring step can never fall back to clear text.
 *
 * Paths carry usernames too (`/Users/alice/.claude.json`), so every path is
 * rewritten here: the home-directory segment is replaced by the user's
 * pseudonym before the path leaves the importer.
 */

export type EndpointPseudonymSubjectKind = "device" | "device_user";

/**
 * Returns a stable pseudonym for a clear value. Must be deterministic per
 * tenant (the same user on two devices gets the same pseudonym) and must not
 * return the clear value. The importers check the second property and refuse
 * the file if a hook echoes its input.
 */
export type EndpointPseudonymHook = (subject: { kind: EndpointPseudonymSubjectKind; value: string }) => string;

export class EndpointPseudonymError extends Error {
  readonly code = "endpoint_pseudonym_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "EndpointPseudonymError";
  }
}

/** wrap a hook so it is checked on every call and memoised for one import */
export function guardPseudonymHook(hook: EndpointPseudonymHook | undefined): EndpointPseudonymHook {
  if (typeof hook !== "function") {
    throw new EndpointPseudonymError(
      "no pseudonymisation hook was supplied: endpoint evidence is never imported with usernames or device names in clear (ADR-0195 decision 20)",
    );
  }
  const memo = new Map<string, string>();
  return (subject) => {
    const k = `${subject.kind}\u0000${subject.value}`;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    const out = hook(subject);
    if (typeof out !== "string" || out.length === 0 || out.length > 128) {
      throw new EndpointPseudonymError("the pseudonymisation hook returned an empty or oversized value");
    }
    if (out === subject.value || (subject.value.length >= 8 && out.toLowerCase().includes(subject.value.toLowerCase()))) {
      throw new EndpointPseudonymError("the pseudonymisation hook returned a value that contains the clear input");
    }
    memo.set(k, out);
    return out;
  };
}

/** home-directory roots whose next segment is a username, compared case-insensitively */
const HOME_ROOTS: ReadonlyArray<readonly string[]> = [["users"], ["home"], ["var", "home"], ["documents and settings"]];

/**
 * Replace the username segment of a home-directory path with its pseudonym.
 * Handles `/Users/<u>/…`, `/home/<u>/…`, `/var/home/<u>/…` and
 * `C:\Users\<u>\…`. Returns the rewritten path (with the input's separator
 * style) and the home-relative remainder (always `/`-separated) used by
 * `config_path` matching. Character-scanned; no regex.
 */
export function pseudonymisePath(
  raw: string,
  hook: EndpointPseudonymHook,
): { path: string; homeRelative: string | null; userPseudonym: string | null } {
  const sep = raw.includes("\\") && !raw.startsWith("/") ? "\\" : "/";
  const parts = raw.split(sep);
  // drive letter (C:) or leading empty segment from an absolute posix path
  let start = 0;
  if (parts[0] === "" || (parts[0]!.length === 2 && parts[0]![1] === ":")) start = 1;
  for (const root of HOME_ROOTS) {
    const segs = parts.slice(start, start + root.length).map((s) => s.toLowerCase());
    if (segs.length === root.length && segs.every((s, i) => s === root[i])) {
      const userIdx = start + root.length;
      const user = parts[userIdx];
      if (user === undefined || user.length === 0 || user === "%") break;
      const pseud = hook({ kind: "device_user", value: user });
      const rewritten = [...parts];
      rewritten[userIdx] = pseud;
      const rest = parts.slice(userIdx + 1);
      return { path: rewritten.join(sep), homeRelative: rest.length > 0 ? rest.join("/") : "", userPseudonym: pseud };
    }
  }
  // /root/… is a system account, not a person; keep it, but give it a home-relative remainder
  if (parts[start]?.toLowerCase() === "root" && start === 1 && sep === "/") {
    return { path: raw, homeRelative: parts.slice(start + 1).join("/"), userPseudonym: null };
  }
  return { path: raw, homeRelative: null, userPseudonym: null };
}

/**
 * Pseudonymise the SID segment of a `HKEY_USERS\<SID>\…` registry key. Other
 * keys are returned unchanged.
 */
export function pseudonymiseRegistryKey(raw: string, hook: EndpointPseudonymHook): { key: string; userPseudonym: string | null } {
  const parts = raw.split("\\");
  if (parts.length >= 2 && parts[0]!.toUpperCase() === "HKEY_USERS" && parts[1]!.length > 0) {
    const pseud = hook({ kind: "device_user", value: `sid:${parts[1]}` });
    const out = [...parts];
    out[1] = pseud;
    return { key: out.join("\\"), userPseudonym: pseud };
  }
  return { key: raw, userPseudonym: null };
}
