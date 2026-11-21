<!-- fold: pending -->
**E16 — Managed browser extension follow-ups ([ADR-0334](../decisions/0334-managed-browser-extension-governance.md), lane E16).**
Surface (a) is built and off by default. Left: the admin screens on #453 (11 KNOWN_UI_GAPS); retention for
`browser_events` (captured prompts are deleted after 30 days by default, owner decision B2); the device-policy signer's
adoption by the endpoint agent (lane E13, owner decision B4) and an in-app audited rotation; verified attribution (an
identity-provider ID token from `chrome.identity` checked by the gateway, replacing today's device-asserted account,
which is bound per device since review #867); (the gateway origin is pinned at build time since #1029, so no CORS is
needed); feeding breach events into the
shadow-AI inventory and detection engine through their contracts; per-role site rules; a browser opt-out for single DLP
rules (an audited relaxation); hardware-bound device keys through the endpoint agent; DLP for script-sent prompts and
file uploads; Firefox (its own fragment, owner decision B3) and Safari; surface (b), browser-driving agents, is superseded by
ADR-0364 (lane E45, owner decision 2026-11-21) and is not an E16 follow-up. Owner decisions B1 to B4 are in the ADR.
