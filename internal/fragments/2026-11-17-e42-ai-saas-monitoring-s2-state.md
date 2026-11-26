<!-- fold: state-recap -->

**2026-11-17 - E42 slice 2: ChatGPT Enterprise and Claude Enterprise connectors ([ADR-0361](../decisions/0361-sanctioned-ai-saas-compliance-monitoring.md), As built slice 2; no migration).**
- ChatGPT Enterprise reads the Compliance Logs Platform's `CONVERSATION_MESSAGE` files: the 307 to a signed URL is
  re-requested through the guard without our key (the guarded fetch's new opt-in `returnRedirects`, off for every
  other caller), the listed SHA-256 is checked, and an unlisted storage host is named for the admin to allow-list.
- Claude Enterprise polls the Compliance API's chats org-wide by `updated_at` and reads each chat's messages,
  tool-result text included.
- Neither vendor can probe a key's scopes, so storing one needs an audited `attestReadOnly` (posture stays `unverified`).
