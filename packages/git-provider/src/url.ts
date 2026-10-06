/**
 * `s.replace(/\/+$/, "")` by a backward scan, in linear time. The regex
 * rescans every run of `/` that does not end the string, so it is quadratic in
 * such a run (CodeQL js/polynomial-redos, ADR-0184). The same fix as
 * `@regulait/api-client`'s base URL (885a122); this package has no workspace
 * dependencies, so it keeps its own copy rather than importing one.
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end -= 1;
  return end === s.length ? s : s.slice(0, end);
}
