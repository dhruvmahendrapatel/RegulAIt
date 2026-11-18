<!-- fold: state-recap -->
**2026-11-18 - Endpoint decision audit and tamper reporting ([ADR-0310](../decisions/0310-vendor-native-managed-settings.md) addendum, lane E1, branch `builder/e1-endpoint-decision-audit`).**
The endpoint hook's decisions now reach the gateway's hash-chained audit. The hook spools each decision locally. The
agent's run loop uploads signed, replay-protected batches to `POST /v1/endpoint-agent/decisions`, and each decision is
one `audit_log` row (allow, deny, ask, or an audit-mode would-deny or would-ask). There is one neutral decision-event
interface (`decisionlog.Event` / `Emitter`) that lane E31's command, file and package rules emit through.
`GET /v1/endpoint-decisions/sessions` flags permission-bypass sessions (`--dangerously-skip-permissions`, `--yolo`)
from the hook's `permission_mode`, and says which agents report no mode (Cursor, Copilot CLI).
`GET /v1/endpoint-decisions/tamper` shows a changed managed file, a missing or weakened hook, and whether the bytes
match an exported bundle. The pending migration is `endpoint_decision_audit` (4 tables, RLS forced). Both views are
API-only gaps on #453 (`KNOWN_UI_GAPS_MAX` 75). Restore of a changed file is a later step that needs admin approval.
