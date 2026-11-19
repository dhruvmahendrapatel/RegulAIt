// ADR-0196 U4: the screens of one chunk, loaded together on the first visit to any of them (see App.tsx).
// ADR-0334 (lane E16, D5): Browser governance has its own chunk and ceiling (owner decision on #453, comment
// 7024071207), so the shared Discovery screens chunk keeps its ceiling.
export { default as BrowserGovernancePage } from "../views/admin/governance/BrowserGovernancePage";
