// X6b (M2): focus moves for rows that leave a list. Kept out of kit.tsx, which is in the entry bundle, as only the
// pages that move focus this way need it.

/**
 * WCAG 2.4.3: move focus to the first candidate that can really take it. A row inside a folded section is in the
 * document but hidden, so focus() on it silently fails; the next candidate is tried instead.
 */
export function focusFirst(...candidates: (HTMLElement | null | undefined)[]): void {
  for (const el of candidates) {
    if (!el || !el.isConnected || el.closest("[hidden]")) continue;
    el.focus();
    if (document.activeElement === el) return;
  }
}

/** the fold button of the contained card that holds `el`, if it has one (in the header's title span, #477 M2) */
export function foldButtonOf(el: Element | null | undefined): HTMLElement | null {
  return el?.closest("section[data-rg-card]")?.querySelector<HTMLElement>(":scope > div > span > button[aria-expanded]") ?? null;
}
