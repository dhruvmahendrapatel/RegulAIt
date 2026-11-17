<!-- fold: pending -->
- **Managed-settings drift screen (ADR-0310 slice 2, lane E1).** `GET /v1/managed-settings/drift` is API-only; the
  drift list with its vendor and device filters is requested on #453 (Governed Designer).
- **Per-server drift (ADR-0310 slice 2).** ADR-0259 reports a remote server's host, never its path, so drift is per
  gateway host, not per `/mcp/<serverId>`. A device carrying a gateway server it is not entitled to is not drift (the
  gateway still refuses its calls). Revisit if the endpoint agent ever reports a path shape-checked against `/mcp/<uuid>`.
