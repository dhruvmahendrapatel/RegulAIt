// ADR-0196 U4: the screens of one chunk, loaded together on the first visit to any of them (see App.tsx).
// ADR-0350 (lane E31): Endpoint policy has its own chunk and ceiling (owner decision on #453, comment 7024071207),
// so the shared Discovery screens chunk keeps its ceiling.
export { default as EndpointPolicyPage } from "../views/admin/endpoint/EndpointPolicyPage";
