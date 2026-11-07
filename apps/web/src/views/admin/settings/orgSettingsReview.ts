/**
 * P3 (#453 c6527514889): how many of a set of org settings need review (relaxed, or unknown because the read did not
 * return them), from the same shared read `OrgSettingsCard` uses, so a tab that hides the card can count them in its
 * label.
 */
import { useQuery } from "@tanstack/react-query";
import type { OrgSettingsResponse } from "../../../api/adminTypes";
import { orgSettingsQuery } from "../adminKit";
import { specsFor, storedValue } from "./orgSettingSpecs";

export function useSettingsToReview(keys: readonly string[]): number {
  const settings = useQuery(orgSettingsQuery<OrgSettingsResponse>());
  const raw = settings.data?.settings;
  if (!raw || typeof raw !== "object") return 0;
  const stored = raw as unknown as Record<string, unknown>;
  return specsFor(keys).filter((spec) => {
    const value = storedValue(spec, stored[spec.key]);
    return value === undefined || spec.isRelaxed(value);
  }).length;
}
