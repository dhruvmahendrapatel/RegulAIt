import type { ReactNode } from "react";
import r from "./registry.module.css";

const glyphs: Record<string, ReactNode> = {
  total: <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />,
  approved: <path d="m6 3 14 9-14 9V3Z" />,
  review: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  risk: <path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v.2" />,
  pending: <><circle cx="12" cy="7" r="4" /><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2Z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  filter: <path d="M3 4h18l-7 8v5l-4 3v-8L3 4Z" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1" />,
  grid: <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />,
  more: <path d="M4 12h.1M12 12h.1M20 12h.1" strokeWidth="3" />,
  empty: <path d="m12 3 8 4v10l-8 4-8-4V7l8-4Zm0 18V11m-8-4 8 4 8-4" />,
  denied: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></>,
};

export function RegistryIcon({ name }: { name: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{glyphs[name]}</svg>;
}

export function RegistryState(props: { kind: "loading" | "empty" | "error" | "denied"; title: string; children?: ReactNode }) {
  const role = props.kind === "error" || props.kind === "denied" ? "alert" : "status";
  return <div className={r.state} data-state={props.kind} role={role}>
    {props.kind === "loading" ? <span className={r.spinner} aria-hidden="true" /> : <RegistryIcon name={props.kind === "error" ? "risk" : props.kind} />}
    <strong>{props.title}</strong>
    {props.children}
  </div>;
}
