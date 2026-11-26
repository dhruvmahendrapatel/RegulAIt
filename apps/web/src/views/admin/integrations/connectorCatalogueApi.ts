/**
 * The connector catalogue's two calls (ADR-0255), beside the screen: the paginated read with the `q` filter, and the
 * enable/disable write. The write goes through `withStepUp`: the gateway refuses an enablement with
 * `step_up_required` (`settings_relax`) until the person confirms it's them, and `onStepUp` lets the screen's
 * reducer show that phase. Disabling takes no step-up there, so the same call simply succeeds.
 */
import { api } from "../../../api/client";
import { api as stepUpApi, promptStepUp, withStepUp, type StepUpAction } from "../../../stepup/stepUp";
import { PAGE_SIZE, cleanQuery, normaliseCatalogue, type Catalogue, type CuratedPiece } from "./connectorCatalogueModel";

export const CATALOGUE_KEY = ["admin", "connector-catalogue"] as const;

/** only what the route accepts (its query schema is strict): limit, offset, and q when there is one */
export function catalogueQuery(p: { q: string; offset: number; limit?: number }): string {
  const qs = new URLSearchParams();
  qs.set("limit", String(p.limit ?? PAGE_SIZE));
  qs.set("offset", String(Math.max(0, Math.floor(p.offset))));
  const q = cleanQuery(p.q);
  if (q) qs.set("q", q);
  return qs.toString();
}

export async function fetchCatalogue(p: { q: string; offset: number; limit?: number }): Promise<Catalogue> {
  return normaliseCatalogue(await api.get<unknown>(`/v1/connector-catalogue?${catalogueQuery(p)}`));
}

export type StepUpAsk = (action: StepUpAction, methods: string[]) => Promise<string | null>;

/** enable or disable one curated piece, with the audited reason; answers the piece as the server now has it */
export async function setPieceEnablement(
  pieceKey: string,
  body: { enabled: boolean; reason: string },
  onStepUp: () => void = () => undefined,
  ask: StepUpAsk = promptStepUp,
): Promise<CuratedPiece | null> {
  const out = await withStepUp(
    (h) => stepUpApi.post<{ piece?: CuratedPiece }>(`/v1/connector-catalogue/${encodeURIComponent(pieceKey)}/enablement`, { enabled: body.enabled, reason: body.reason.trim() }, h),
    (action, methods) => {
      onStepUp();
      return ask(action, methods);
    },
  );
  return out?.piece ?? null;
}
