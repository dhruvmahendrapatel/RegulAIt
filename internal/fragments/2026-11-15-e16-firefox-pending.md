<!-- fold: pending -->
**E16 — Firefox build of the managed browser extension (owner decision B3, 2026-11-15; [ADR-0334](../decisions/0334-managed-browser-extension-governance.md)).**
Surface (a) ships for Chromium-based browsers only. A later slice adds Firefox: its enterprise policy channel
(`policies.json` `ExtensionSettings` force-install and `3rdparty` managed storage), MV3 `declarativeNetRequest`
redirects to an extension page, the identity read it offers in place of `chrome.identity.getProfileUserInfo`, and its
own signing and update channel. The governed catalogue, policy envelope, DLP table and gateway routes are unchanged.
