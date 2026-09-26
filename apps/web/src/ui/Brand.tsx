/**
 * The regulAIt mark and wordmark.
 *
 * Brand rules this file exists to enforce in one place, so no screen has to
 * remember them:
 *
 *  - The mark is an abstract letter R drawn as a governance graph: four anchor
 *    nodes joined by edges, with the AI node seated where the bowl of the R
 *    would close. It reads as a network under supervision.
 *  - The AI node is the ONLY coloured element of the mark, and it is always
 *    Signal Cyan. Never recolour it, rotate the mark, add glows or gradients,
 *    or outline the nodes.
 *  - Anchor nodes are Graphite 950 on light, Graphite 50 on dark.
 *  - Edges are stroke weight 1/16 of mark height, with round caps.
 *  - Minimum clearspace on all sides equals the diameter of the AI node.
 *  - The wordmark is Gantari Bold, all lowercase except AI. Below 24px the AI
 *    pair switches to Signal 700 for contrast on light grounds; on dark grounds
 *    it brightens to Signal 400.
 *  - "Regulait", "regulait" and "RegulAIt" are all misspellings of the mark.
 *    `WORDMARK` below is the only spelling that may reach a user's eyes.
 */
import s from "./brand.module.css";

/** The one correct spelling of the product name in user-facing copy. */
export const WORDMARK = "regulAIt";

/**
 * The node mark. Geometry is expressed in a 64-unit box so the edge stroke can
 * be exactly 1/16 of the mark height (4 units) as the brand specifies.
 *
 * `tone` picks the anchor-node colour: "auto" follows the current theme's ink,
 * "onDark" pins them to Graphite 50 for the always-dark rail.
 */
export function NodeMark(props: { size?: number; tone?: "auto" | "onDark"; title?: string }) {
  const size = props.size ?? 28;
  const anchor = props.tone === "onDark" ? "var(--rg-dark-ink)" : "var(--rg-ink)";
  const labelled = props.title != null;
  return (
    <svg
      className={s.mark}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role={labelled ? "img" : "presentation"}
      aria-label={props.title}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    >
      {/* Edges — stroke 4 = 1/16 of the 64-unit mark height, round caps.
          The stem of the R runs bottom-left to top-left; the bowl closes on the
          AI node; the leg kicks out to the bottom-right anchor. */}
      <g stroke={anchor} strokeWidth="4" strokeLinecap="round" strokeOpacity="0.55">
        <line x1="16" y1="52" x2="16" y2="14" />
        <line x1="16" y1="14" x2="44" y2="20" />
        <line x1="44" y1="20" x2="16" y2="33" />
        <line x1="16" y1="33" x2="46" y2="50" />
      </g>
      {/* Anchor nodes */}
      <circle cx="16" cy="14" r="5.5" fill={anchor} />
      <circle cx="16" cy="33" r="5.5" fill={anchor} />
      <circle cx="16" cy="52" r="5.5" fill={anchor} />
      <circle cx="46" cy="50" r="5.5" fill={anchor} />
      {/* The AI node — the only coloured element of the mark, seated where the
          bowl of the R closes. Always Signal Cyan. */}
      <circle cx="44" cy="20" r="7" fill="var(--rg-signal)" />
    </svg>
  );
}

/**
 * The wordmark. `tone="onDark"` brightens the AI pair to Signal 400, which is
 * what the brand requires on dark grounds.
 */
export function Wordmark(props: { tone?: "auto" | "onDark"; className?: string }) {
  return (
    <span
      className={[s.word, props.tone === "onDark" ? s.wordOnDark : "", props.className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      regul<i className={s.ai}>AI</i>t
    </span>
  );
}

/**
 * Mark + wordmark + optional product descriptor — the full lockup.
 *
 * The descriptor takes the product accent (`--rg-product`), which is identity
 * only. Actions stay Signal Cyan.
 */
export function Lockup(props: { descriptor?: string; tone?: "auto" | "onDark"; markSize?: number }) {
  return (
    <span className={s.lockup}>
      <NodeMark size={props.markSize ?? 26} tone={props.tone} />
      <span className={s.lockupText}>
        <Wordmark tone={props.tone} />
        {props.descriptor != null && <span className={s.descriptor}>{props.descriptor}</span>}
      </span>
    </span>
  );
}

/**
 * The endorsement line. IBM Plex Mono caps at no more than 40% of the
 * wordmark's cap height; it belongs in footers, sign-in screens and legal
 * surfaces — never in the app chrome.
 */
export function Endorsement(props: { className?: string }) {
  return (
    <span className={[s.endorsement, props.className ?? ""].filter(Boolean).join(" ")}>
      A Secure Shield Labs product
    </span>
  );
}
