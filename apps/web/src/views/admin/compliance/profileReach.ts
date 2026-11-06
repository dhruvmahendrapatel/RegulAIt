/** ADR-0208 (G7): what a compliance profile's tag reaches, as one sentence ("2 projects, 1 team and 0 …"). */
import type { ComplianceProfileUsage } from "../../../api/adminTypes";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** `onlyNonZero` drops the kinds nothing carries (for an "in use by …" line) */
export function reachSentence(u: ComplianceProfileUsage | undefined, onlyNonZero = false): string {
  const parts: Array<[number, string, string]> = [
    [u?.projects.length ?? 0, "project", "projects"],
    [u?.pendingProjects.length ?? 0, "pending project", "pending projects"],
    [u?.teams.length ?? 0, "team", "teams"],
    [u?.resources.length ?? 0, "infrastructure resource", "infrastructure resources"],
  ];
  return andList(parts.filter(([n], i) => (onlyNonZero ? n > 0 : n > 0 || i !== 1)).map(([n, one, many]) => plural(n, one, many)));
}
