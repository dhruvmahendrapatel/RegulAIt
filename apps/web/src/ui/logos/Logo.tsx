import monoList from "./mono.json";
import s from "./logo.module.css";

/**
 * Third-party logos (model providers, apps, integrations), vendored as static
 * SVG files so the console works air-gapped — no logo CDN, no runtime fetch.
 * Rendered as <img> (never injected markup). Single-colour marks are drawn
 * dark and inverted in dark mode. An unknown key falls back to a monogram, so
 * a provider we have no mark for still gets a tidy tile. Sources and licences:
 * LICENSES.md beside this file. Logos identify the third-party service only.
 */
const urls = import.meta.glob("./svg/*.svg", { query: "?url", import: "default", eager: true }) as Record<string, string>;
const byKey = new Map(Object.entries(urls).map(([path, url]) => [path.replace(/^.*\/(.+)\.svg$/, "$1"), url]));
const mono = new Set<string>(monoList as string[]);

export const hasLogo = (key: string | null | undefined): boolean => !!key && byKey.has(key);

// 700-step tints: white monogram letters hold WCAG AA (4.5:1) on every one
const TINTS = ["#1d4ed8", "#6d28d9", "#0e7490", "#047857", "#b45309", "#be185d", "#4338ca", "#0f766e"];

export function Logo(props: { name: string | null | undefined; label: string; size?: number; className?: string }) {
  const size = props.size ?? 24;
  const url = props.name ? byKey.get(props.name) : undefined;
  if (url) {
    return (
      <img
        src={url}
        alt={props.label}
        width={size}
        height={size}
        className={[s.logo, props.name && mono.has(props.name) ? s.mono : "", props.className ?? ""].join(" ").trim()}
        draggable={false}
      />
    );
  }
  const initials = props.label
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";
  let h = 0;
  for (const c of props.label) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span
      role="img"
      aria-label={props.label}
      className={[s.monogram, props.className ?? ""].join(" ").trim()}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)), background: TINTS[h % TINTS.length] }}
    >
      {initials}
    </span>
  );
}
