// ADR-0196 U4: the screens of one chunk, loaded together on the first visit to any of them (see App.tsx).
// ADR-0225 (P13 d): the two PUBLIC trust pages, outside the app shell, in their own chunk.
export { AuditorPortalPage, TrustCenterPage } from "../views/trust/PublicTrustPages";
