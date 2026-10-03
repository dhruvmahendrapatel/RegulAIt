-- Unknown historical provenance remains unknown; do not guess from JSON keys.
alter table approvals
  add column arguments_preview_kind text,
  add column approval_scope text,
  add constraint approvals_preview_kind_check
    check (arguments_preview_kind in ('arguments_v1', 'mcp_redacted_v1')),
  add constraint approvals_scope_check
    check (approval_scope in ('action', 'tool')),
  add constraint approvals_redacted_scope_check
    check (arguments_preview_kind is distinct from 'mcp_redacted_v1'
      or approval_scope is not distinct from 'action');
