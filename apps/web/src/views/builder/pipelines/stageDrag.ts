/**
 * ADR-0341 slice 2 — what the palette and the lazy canvas share, kept out of the canvas chunk so the palette never
 * pulls @xyflow/react into the page's own chunk.
 */

/** the drag type a palette entry carries (its value is the stage type) */
export const STAGE_DRAG_TYPE = "application/x-regulait-stage-type";

/** the stage index a point at `x` (flow coordinates, compared with node centres) falls before, among the other stages */
export function indexAtX(centres: ReadonlyArray<{ id: string; x: number }>, x: number, exclude?: string): number {
  return centres.filter((c) => c.id !== exclude && c.x < x).length;
}
