/**
 * ADR-0195 SD0 — the sightings kept on a shadow-AI finding (its bounded
 * evidence leads): where each was found (path, line, commit), the NAMES seen
 * (never values) and the person behind it as a pseudonym. A pseudonym links to
 * the Discovery sources page's reveal card, prefilled; revealing still needs a
 * step-up there.
 */
import { Link } from "react-router-dom";
import v from "../../views.module.css";
import { sightingLines, type SightingView } from "./discoverySourcesModel";

export function DiscoverySightings(props: { evidence: readonly SightingView[] | undefined }) {
  const lines = sightingLines(props.evidence);
  if (lines.length === 0) return <span className={v.faint}>—</span>;
  return (
    <div className={v.stackTight}>
      {lines.map((l, i) => (
        <span key={i} className={v.faint}>
          {l.text}
          {l.actor && (
            <>
              {" · by "}
              <Link to={`/admin/shadow-ai/discovery-sources?pseudonym=${encodeURIComponent(l.actor)}`} className={v.mono}>
                {l.actor}
              </Link>
            </>
          )}
        </span>
      ))}
    </div>
  );
}
