import type { ReactNode } from "react";

/** Static glyphs for the registry's headline tiles (approved mockup); decorative only. */
const glyphs: Record<string, ReactNode> = {
  total: <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />,
  approved: <path d="M20 6 9 17l-5-5" />,
  review: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  risk: <path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v.2" />,
  pending: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6m0 3v.2" /></>,
};

export function RegistryIcon({ name, className }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {glyphs[name]}
    </svg>
  );
}
