<!-- fold: state-recap -->

**2026-11-15 - managed browser extension, surface (a) ([ADR-0334](../decisions/0334-managed-browser-extension-governance.md), builder lane E16, migration `browser_governance` (numbered at merge)).**
- **Built:** `agents/browser/` (MV3, Chromium, force-installed by the customer's browser management only; host
  permissions exactly the governed site catalogue) and the gateway's `/v1/browser-extension/*` channel and
  `/v1/browser-governance/*` admin routes. Off by default; turning it on, audit mode, allowing a site and prompt
  capture are each a `settings_relax` step-up, audited.
- **Fail closed:** a static ruleset blocks every governed site until a signed (EdDSA), unexpired, per-user policy
  verifies against keys pinned in managed storage. DLP on the shared `dlp.secret.*` rules in RE2 at send time;
  account rules from the profile identity; breach events tied to user, device and a keyed conversation ref.
- **Left:** the admin screens (11 KNOWN_UI_GAPS on #453), retention, inventory feed, surface (b) (browser-driving
  agents, PR 2).
