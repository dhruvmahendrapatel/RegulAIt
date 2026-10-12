/**
 * Batch U4 — editing a model card (`PATCH /v1/mrm/cards/:id`), mirroring
 * `updateModelCardSchema` in packages/shared/src/mrm.ts.
 *
 * Only the fields the person changed are sent: the gateway audits the edited
 * field NAMES (`detail.fields`), so sending an untouched field would record an
 * edit nobody made. A cleared optional text field is sent as `null` (the schema
 * is `nullish`, and null clears it); a cleared intended use is refused here
 * because the schema requires one.
 */

export interface EditableCard {
  intendedUse: string;
  limitations: string | null;
  note?: string | null;
  dataClaims: Record<string, unknown>;
  standardRefs: string[];
  pinnedModelVersion?: string | null;
  agentId: string | null;
}

export interface CardDraft {
  intendedUse: string;
  limitations: string;
  note: string;
  dataClaims: string;
  standardRefs: string;
  pinnedModelVersion: string;
}

export const draftOfCard = (c: EditableCard): CardDraft => ({
  intendedUse: c.intendedUse,
  limitations: c.limitations ?? "",
  note: c.note ?? "",
  dataClaims: Object.keys(c.dataClaims ?? {}).length ? JSON.stringify(c.dataClaims, null, 2) : "",
  standardRefs: (c.standardRefs ?? []).join(", "),
  pinnedModelVersion: c.pinnedModelVersion ?? "",
});

const refsOf = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** stable JSON for comparing two values regardless of key order */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );

export type CardPatch = Partial<{
  intendedUse: string;
  limitations: string | null;
  note: string | null;
  dataClaims: Record<string, unknown>;
  standardRefs: string[];
  pinnedModelVersion: string | null;
}>;

/** the PATCH body (changed fields only), or the problems that stop it being sent */
export function cardPatch(card: EditableCard, draft: CardDraft): { body: CardPatch; problems: string[] } {
  const body: CardPatch = {};
  const problems: string[] = [];
  const use = draft.intendedUse.trim();
  if (use !== card.intendedUse) {
    if (!use) problems.push("Intended use is required.");
    else if (use.length > 2000) problems.push("Intended use must be at most 2,000 characters.");
    else body.intendedUse = use;
  }
  const limits = draft.limitations.trim();
  if (limits !== (card.limitations ?? "")) {
    if (limits.length > 20_000) problems.push("Known limitations must be at most 20,000 characters.");
    else body.limitations = limits || null;
  }
  const note = draft.note.trim();
  if (note !== (card.note ?? "")) {
    if (note.length > 4000) problems.push("Note must be at most 4,000 characters.");
    else body.note = note || null;
  }
  const claimsText = draft.dataClaims.trim();
  let claims: Record<string, unknown> = {};
  if (claimsText) {
    try {
      const parsed: unknown = JSON.parse(claimsText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) problems.push("Provider data claims must be a JSON object, like {\"retention\": \"30 days\"}.");
      else claims = parsed as Record<string, unknown>;
    } catch {
      problems.push("Provider data claims are not valid JSON.");
    }
  }
  if (!problems.some((p) => p.startsWith("Provider data claims")) && canon(claims) !== canon(card.dataClaims ?? {})) body.dataClaims = claims;
  const refs = refsOf(draft.standardRefs);
  if (canon(refs) !== canon(card.standardRefs ?? [])) {
    if (refs.length > 50) problems.push("A card can cite at most 50 standard references.");
    else if (refs.some((r) => r.length > 200)) problems.push("Each standard reference must be at most 200 characters.");
    else body.standardRefs = refs;
  }
  const pin = draft.pinnedModelVersion.trim();
  if (pin !== (card.pinnedModelVersion ?? "")) {
    if (pin && !card.agentId) problems.push("A pinned model version applies only to a card on an agent.");
    else if (pin.length > 200) problems.push("The pinned model version must be at most 200 characters.");
    else body.pinnedModelVersion = pin || null;
  }
  return { body, problems };
}

/** the gateway's refusals of the edit, as sentences */
export const CARD_EDIT_REFUSALS: Readonly<Record<string, string>> = {
  unknown_model_card: "This model card no longer exists. Reload the page.",
  pinned_version_invalid: "The pinned model version does not match the model this card's agent serves.",
  pinned_version_needs_agent: "A pinned model version applies only to a card on an agent.",
};
