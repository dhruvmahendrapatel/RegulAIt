/**
 * ADR-0341: an RFC 6902 patch between two JSON documents, for diff views (the workflow template builder shows what a
 * draft or an older version changes against the live template). `rfc6902` (MIT, pinned in this package's lockfile
 * entry and listed in THIRD_PARTY.md) does the work; ADR-0246 already uses it for MCP definition pins.
 */
import { createPatch, type Operation } from "rfc6902";

export type JsonPatchOperation = Operation;

/** the operations that turn `before` into `after` (an empty list when they are equal) */
export function jsonPatch(before: unknown, after: unknown): JsonPatchOperation[] {
  return createPatch(before ?? null, after ?? null);
}
